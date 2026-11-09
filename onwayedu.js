// 아침점호 → 온웨이에듀 벌점 자동 입력 — 설정·보낼 명단·보내기·결과(태하관·서현관 앱 공통, 두 저장소에 바이트까지 같게)
//
// 기본은 꺼짐: 꺼져 있으면 온웨이에듀를 부르지 않고 연동 저장도 하지 않는다(설정 칸만 기록/백업 관리 창 안에 보인다).
// 저장 칸은 rollcall_ 접두어 밖(onway_cfg_<앱>, onway_log_<앱>_<날짜>) — 기존 백업·복원·동기화에 들어가지 않아 비밀 코드가 백업·드라이브로 나가지 않고,
// 옛 백업을 복원해도 오늘 보낸 기록이 지워지지 않는다. 비밀 코드·토큰은 화면·기록·console 어디에도 그대로 남기지 않는다.
// 설계: ROSA reviews/DORM-MORNING-ONWAY/review-purpose.md
(function (root) {
  "use strict";

  const API_BASE = "https://hansung-hs.onwayedu.co.kr/rnf_api";
  const TEST_IDS = ["1166", "1177", "1199"]; // 온웨이에듀 실험용 학번(사용자 11-09) — 시험 보내기는 이 셋만
  const FETCH_TIMEOUT_MS = 15000;
  const LOG_KEEP_DAYS = 60;
  const SENDING_STALE_MS = 60 * 1000; // 이보다 오래된 "보내는 중"은 앱이 꺼진 것으로 보고 "확인 필요"로 본다
  const SAME_FAIL_STOP = 3; // 같은 사유의 실패가 이만큼 이어지면 멈춤(사감 이름·코드 문제)
  const REASON_MAX = 80;
  const MEMO = { A: "기숙사 앱 자동 입력(아침점호 지각)", B: "기숙사 앱 자동 입력(아침점호 불참)" };
  const TEST_MEMO = "기숙사 앱 연동 시험";
  const TYPE_NAME = { A: "지각", B: "불참" };
  const OK_STATES = ["ok", "ok_manual"];

  // ---------- 순수 함수 ----------
  const pad2 = (n) => String(n).padStart(2, "0");
  const cut = (s, n) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s);

  // 시각(시·분)을 5분 단위로 내린 "HH:MM" — 06:47 → 06:45
  function floor5(h, m) {
    const hh = Number(h), mm = Number(m);
    if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const t = hh * 60 + mm - ((hh * 60 + mm) % 5);
    return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
  }

  // 학번 규칙(사용자 11-09): 4자리 — 첫째 자리 학년 1~3, 둘째 자리 반 1~7, 뒤 두 자리 번호 01~99
  const STUDENT_RE = /^[1-3][1-7](0[1-9]|[1-9][0-9])$/;
  function validStudentId(id) {
    return typeof id === "string" && STUDENT_RE.test(id);
  }

  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // 보낼 명단 — 사전 부재·명단에 없는·학번 규칙 밖·정상 학생은 보내지 않는다.
  // 미입력 불참은 ① 세션 날짜가 오늘이고 지금이 불참 처리 시간 이후 ② 점호완료가 대상의 절반 이상일 때만 만든다(인원수 입력은 사용자 결정으로 뺌 — 마지막 확인 문구에 인원수 표시).
  function buildTargets(s) {
    const info = s.studentsInfo || {};
    const absent = new Set(s.absentList || []);
    const log = s.attendanceLog || {};
    const late = [], absentEntered = [], absentMissing = [], excluded = [];
    let target = 0, done = 0;
    for (const id of Object.keys(info)) {
      if (absent.has(id)) continue;
      target++;
      const st = log[id];
      if (st === "정상" || st === "점호지각" || st === "점호불참") done++;
    }
    for (const id of Object.keys(log)) {
      const st = log[id];
      if (st !== "점호지각" && st !== "점호불참") continue;
      if (absent.has(id)) continue;
      if (!info[id]) { excluded.push({ id, why: "명단에 없음" }); continue; }
      if (!validStudentId(id)) { excluded.push({ id, why: "학번 규칙 밖" }); continue; }
      (st === "점호지각" ? late : absentEntered).push(id);
    }
    const missingAll = Object.keys(info).filter((id) => !absent.has(id) && !log[id]);
    let missingBlocked = null;
    if (s.sessionDate !== s.today) missingBlocked = "not-today";
    else if (!(Number(s.nowMinutes) >= Number(s.endMinutes))) missingBlocked = "before-end";
    else if (done * 2 < target) missingBlocked = "too-few-done";
    if (!missingBlocked) {
      for (const id of missingAll) {
        if (validStudentId(id)) absentMissing.push(id);
        else excluded.push({ id, why: "학번 규칙 밖" });
      }
    }
    late.sort(byId); absentEntered.sort(byId); absentMissing.sort(byId);
    excluded.sort((a, b) => byId(a.id, b.id));
    return { late, absentEntered, absentMissing, missingCount: missingAll.length, missingBlocked, excluded, target, done };
  }

  function parseJson(text) {
    try {
      const j = JSON.parse(text);
      return j && typeof j === "object" && !Array.isArray(j) ? j : null;
    } catch (e) {
      return null;
    }
  }

  // 벌점 응답 판정 — ok는 HTTP 200·JSON·result "ok"만. fail(들어가지 않음)은 서버가 4xx·JSON·result "error"로 거절한 경우만.
  // 그 밖의 모든 것(5xx, 알 수 없는 result, JSON 아님)은 unknown — 들어갔는지 모르므로 사용자가 확인하기 전에는 다시 보내지 않는다.
  function judgeAct(status, text) {
    const j = parseJson(text);
    if (status === 200 && j && j.result === "ok") return { state: "ok", reason: "" };
    if (status >= 400 && status < 500 && j && j.result === "error") return { state: "fail", reason: String(j.message == null ? "거절됨" : j.message) };
    if (!j) return { state: "unknown", reason: `HTTP ${status} · 응답이 JSON이 아님` };
    return { state: "unknown", reason: `HTTP ${status} · ${j.result == null ? "결과 없음" : j.result}${j.message ? " · " + j.message : ""}` };
  }

  // 토큰 응답 판정 — HTTP 200·JSON·result "success"(또는 "ok")·16자 이상 token이어야 쓴다(짧은 토큰은 오류 문구에서 가리기 어려워 받지 않음 — 감사실장 P1)
  const TOKEN_MIN = 16;
  function judgeToken(status, text) {
    const j = parseJson(text);
    if (status === 200 && j && (j.result === "success" || j.result === "ok") && typeof j.token === "string" && j.token.length >= TOKEN_MIN) return { ok: true, token: j.token };
    return { ok: false, reason: j ? String(j.message == null ? (j.result == null ? "토큰 없음" : j.result) : j.message) : `HTTP ${status} · 응답이 JSON이 아님` };
  }

  const isTokenError = (reason) => /토큰|token/i.test(String(reason || ""));

  // 화면·기록에 남기는 사유 — 제어 문자를 지우고, 비밀 코드·토큰 문자열을 ***로 가리고, 80자로 줄인다
  function redact(text, secrets) {
    let s = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ");
    for (const sec of secrets || []) if (typeof sec === "string" && sec.length >= 4) s = s.split(sec).join("***");
    return cut(s, REASON_MAX);
  }

  const cfgKey = (appId) => `onway_cfg_${appId}`;
  const logKey = (appId, date) => `onway_log_${appId}_${date}`;

  // 설정 — 깨졌거나 없으면 꺼짐
  function parseCfg(raw) {
    const j = raw == null ? null : parseJson(raw);
    const code = j && typeof j.code === "string" ? j.code : "";
    const teacher = j && typeof j.teacher === "string" ? j.teacher : "";
    return { enabled: !!(j && j.enabled === true && canEnable({ code, teacher })), code, teacher };
  }
  function canEnable(cfg) {
    return !!(cfg && typeof cfg.code === "string" && cfg.code.length >= 4 && typeof cfg.teacher === "string" && cfg.teacher.trim().length > 0);
  }
  const maskCode = (code) => (code && code.length >= 2 ? `${code.slice(0, 2)}…` : "");

  // 보낸 기록 { "<학번>": { A: {state, reason, at}, B: {...} } } — 없으면 빈 기록. 깨졌거나 모양이 하나라도 틀리면 ok:false
  // (모양만 맞는 엉뚱한 기록을 "보낸 적 없음"으로 읽어 다시 보내지 않게 — 감사실장 P2)
  const LOG_STATES = ["sending", "ok", "ok_manual", "fail", "unknown"];
  function validLog(j) {
    for (const id of Object.keys(j)) {
      const rec = j[id];
      if (!/^\d{4}$/.test(id) || !rec || typeof rec !== "object" || Array.isArray(rec)) return false;
      for (const t of Object.keys(rec)) {
        const e = rec[t];
        if ((t !== "A" && t !== "B") || !e || typeof e !== "object" || !LOG_STATES.includes(e.state) || typeof e.at !== "number" || typeof e.reason !== "string") return false;
      }
    }
    return true;
  }
  function parseLog(raw) {
    if (raw == null) return { ok: true, log: {} };
    const j = parseJson(raw);
    return j && validLog(j) ? { ok: true, log: j } : { ok: false, log: null };
  }

  function effectiveState(entry, now) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.state === "sending") return now - Number(entry.at || 0) > SENDING_STALE_MS ? "unknown" : "sending";
    return ["ok", "ok_manual", "fail", "unknown"].includes(entry.state) ? entry.state : "unknown";
  }

  // 확인 창에 보일 학생 줄의 모습 — kind: new(처음)·fail(전에 거절됨)·sent(보냄)·sending(보내는 중)·unknown(확인 필요)·other(다른 유형을 이미 보냄)
  function rowStatus(log, id, type, now) {
    const other = type === "A" ? "B" : "A";
    const rec = (log && log[id]) || {};
    const same = effectiveState(rec[type], now);
    const oth = effectiveState(rec[other], now);
    if (OK_STATES.includes(same)) return { kind: "sent", checked: false, selectable: false };
    if (same === "sending") return { kind: "sending", checked: false, selectable: false };
    const otherBlocking = OK_STATES.includes(oth) || oth === "unknown" || oth === "sending";
    if (same === "unknown") return { kind: "unknown", checked: false, selectable: oth !== "sending", otherType: otherBlocking ? other : null };
    if (otherBlocking) return { kind: "other", checked: false, selectable: oth !== "sending", otherType: other, otherState: oth };
    return { kind: same === "fail" ? "fail" : "new", checked: true, selectable: true };
  }

  // 보내기 직전(다시 읽은 기록으로) — 확인 창에서 본 모습보다 더 막혀 있으면 건너뛴다(다른 창이 그새 보냈거나 보내는 중)
  function mayStart(log, id, type, decidedKind, now) {
    const cur = rowStatus(log, id, type, now);
    if (cur.kind === "new" || cur.kind === "fail") return true;
    if (cur.kind === "unknown") return decidedKind === "unknown";
    if (cur.kind === "other") return decidedKind === "other" && cur.selectable;
    return false;
  }

  function setEntry(log, id, type, state, reason, now) {
    const next = Object.assign({}, log);
    next[id] = Object.assign({}, next[id] || {});
    next[id][type] = { state, reason: reason || "", at: now };
    return next;
  }

  // 지울 보낸 기록 키 — 이 앱의 것, 날짜 형식이 맞고, 오늘·지금 세션 날짜가 아니고, 보관 일수가 지난 것만
  function pruneKeys(keys, appId, today, sessionDate, keepDays) {
    const prefix = `onway_log_${appId}_`;
    const dayNo = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
    };
    const t = dayNo(today);
    if (t == null) return [];
    return keys.filter((k) => {
      if (typeof k !== "string" || !k.startsWith(prefix)) return false;
      const d = k.slice(prefix.length);
      const n = dayNo(d);
      if (n == null || d === today || d === sessionDate) return false;
      return t - n > keepDays;
    });
  }

  const testIdAllowed = (id, studentsInfo) => TEST_IDS.includes(id) && !(studentsInfo && Object.prototype.hasOwnProperty.call(studentsInfo, id));

  // ---------- 저장·네트워크 ----------
  function defaultDeps() {
    return {
      storage: root.localStorage,
      fetchFn: root.fetch ? root.fetch.bind(root) : null,
      locks: root.navigator && root.navigator.locks ? root.navigator.locks : null,
      now: () => Date.now(),
    };
  }

  function readCfg(appId, deps) {
    try { return parseCfg(deps.storage.getItem(cfgKey(appId))); } catch (e) { return parseCfg(null); }
  }
  function writeCfg(appId, cfg, deps) {
    try { deps.storage.setItem(cfgKey(appId), JSON.stringify({ enabled: !!cfg.enabled, code: cfg.code || "", teacher: cfg.teacher || "" })); return true; } catch (e) { return false; }
  }
  function readLog(appId, date, deps) {
    try { return parseLog(deps.storage.getItem(logKey(appId, date))); } catch (e) { return { ok: false, log: null }; }
  }
  function writeLog(appId, date, log, deps) {
    try { deps.storage.setItem(logKey(appId, date), JSON.stringify(log)); return true; } catch (e) { return false; }
  }

  async function postForm(url, params, deps) {
    const body = new URLSearchParams(params).toString();
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
      const res = await deps.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: ctrl ? ctrl.signal : undefined,
        cache: "no-store",
        credentials: "omit",
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (e) {
      return { error: e && e.name === "AbortError" ? "시간 초과" : "연결 끊김" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getToken(code, deps) {
    const r = await postForm(`${API_BASE}/request_token.php`, { company_code: code }, deps);
    if (r.error) return { ok: false, reason: r.error };
    return judgeToken(r.status, r.text);
  }

  async function sendAct(p, deps) {
    const r = await postForm(`${API_BASE}/request_act.php`, {
      company_code: p.code, token: p.token, student_info: p.id, in_date: p.date, in_time: p.time,
      teacher_name: p.teacher, place: p.place, memo: p.memo, type: p.type,
    }, deps);
    if (r.error) return { state: "unknown", reason: r.error };
    return judgeAct(r.status, r.text);
  }

  // 한 번에 한 곳에서만 — 이 창 안의 표시 + Web Locks(설치 앱과 크롬 탭이 동시에 열려도 하나만)
  let running = false;
  async function exclusive(appId, deps, fn) {
    if (running) return { busy: true };
    running = true;
    try {
      if (deps.locks && typeof deps.locks.request === "function") {
        let out = { busy: true };
        await deps.locks.request(`onway-send-${appId}`, { ifAvailable: true }, async (lock) => {
          if (!lock) return;
          out = await fn();
        });
        return out;
      }
      return await fn();
    } finally {
      running = false;
    }
  }

  // 점호 명단 보내기 — items: [{ id, type: "A"|"B", decided: 확인 창에서 본 kind, time: "HH:MM" }]
  async function runSend(opts, depsIn) {
    const deps = Object.assign(defaultDeps(), depsIn || {});
    return exclusive(opts.appId, deps, () => sendAll(opts, deps));
  }

  // 보내기 직전 확인 — 확인 창에서 본 날짜가 아직 오늘인지, 본 설정(코드·사감 이름)이 그대로인지(자정·다른 창 — 감사실장 P2)
  function guardStop(opts, cfg) {
    if (typeof opts.today === "function" && opts.today() !== opts.date) return "날짜가 바뀌어(자정이 지나) 멈췄습니다 — 확인 창을 다시 열어 주세요";
    if (opts.expect && (cfg.code !== opts.expect.code || cfg.teacher !== opts.expect.teacher)) return "설정(코드·사감 이름)이 바뀌어 멈췄습니다 — 확인 창을 다시 열어 주세요";
    return null;
  }

  async function sendAll(opts, deps) {
    const { appId, date, place, items, onProgress } = opts;
    const cfg = readCfg(appId, deps);
    const results = [];
    const notSent = (from, why) => { for (let k = from; k < items.length; k++) results.push({ id: items[k].id, type: items[k].type, state: "notsent", reason: why }); };
    if (!cfg.enabled) { notSent(0, "연동이 꺼져 있음"); return { results, stopped: "연동이 꺼져 있습니다" }; }
    const g0 = guardStop(opts, cfg);
    if (g0) { notSent(0, "멈춤"); return { results, stopped: g0 }; }
    const secrets = [cfg.code];
    let tk = await getToken(cfg.code, deps);
    if (!tk.ok) { notSent(0, "토큰을 받지 못함"); return { results, stopped: `토큰을 받지 못했습니다: ${redact(tk.reason, secrets)}` }; }
    let token = tk.token;
    secrets.push(token);
    // 기록은 쓸 때마다 최신을 다시 읽어 그 학생 칸만 바꾼다 — 기다리는 사이의 다른 변경을 옛 기록으로 덮지 않게(감사실장 P2)
    const commit = (id, type, state, reason) => {
      const r = readLog(appId, date, deps);
      return r.ok && writeLog(appId, date, setEntry(r.log, id, type, state, reason, deps.now()), deps);
    };
    let lastFail = null, sameFail = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const g = guardStop(opts, readCfg(appId, deps));
      if (g) { notSent(i, "멈춤"); return { results, stopped: g }; }
      const read = readLog(appId, date, deps);
      if (!read.ok) { notSent(i, "보낸 기록을 읽지 못함"); return { results, stopped: "보낸 기록을 읽지 못해 멈췄습니다(저장 공간 확인)" }; }
      if (!mayStart(read.log, it.id, it.type, it.decided, deps.now())) {
        results.push({ id: it.id, type: it.type, state: "skipped", reason: "이미 보냈거나 다른 곳에서 보내는 중" });
        continue;
      }
      let verdict = null, retried = false;
      for (;;) {
        if (!commit(it.id, it.type, "sending", "")) { notSent(i, "보낸 기록을 쓰지 못함"); return { results, stopped: "보낸 기록을 쓰지 못해 보내지 않고 멈췄습니다(저장 공간 확인)" }; }
        verdict = await sendAct({ code: cfg.code, token, id: it.id, date, time: it.time, teacher: cfg.teacher, place, memo: MEMO[it.type], type: it.type }, deps);
        if (verdict.state === "fail" && isTokenError(verdict.reason) && !retried) {
          retried = true;
          tk = await getToken(cfg.code, deps);
          if (tk.ok) { token = tk.token; secrets.push(token); continue; }
        }
        break;
      }
      const reason = redact(verdict.reason, secrets);
      const wrote = commit(it.id, it.type, verdict.state, reason);
      results.push({ id: it.id, type: it.type, state: verdict.state, reason });
      if (typeof onProgress === "function") { try { onProgress(i + 1, items.length); } catch (e) {} }
      if (!wrote) { notSent(i + 1, "멈춤"); return { results, stopped: "결과를 기록하지 못해 멈췄습니다(저장 공간 확인)" }; }
      if (verdict.state === "unknown") { notSent(i + 1, "멈춤"); return { results, stopped: "응답을 확인하지 못해 멈췄습니다 — 온웨이에듀 화면에서 확인해 주세요" }; }
      if (verdict.state === "fail") {
        if (retried && isTokenError(verdict.reason)) { notSent(i + 1, "멈춤"); return { results, stopped: "토큰 오류가 이어져 멈췄습니다 — 비밀 코드를 확인해 주세요" }; }
        sameFail = reason === lastFail ? sameFail + 1 : 1;
        lastFail = reason;
        if (sameFail >= SAME_FAIL_STOP) { notSent(i + 1, "멈춤"); return { results, stopped: "같은 실패가 이어져 멈췄습니다 — 사감 이름·비밀 코드를 확인해 주세요" }; }
      } else {
        lastFail = null; sameFail = 0;
      }
    }
    return { results, stopped: null };
  }

  // 시험 보내기 — 실험용 학번(1166·1177·1199) 하나만, 점호 보낸 기록에는 남기지 않는다
  async function runTestSend(opts, depsIn) {
    const deps = Object.assign(defaultDeps(), depsIn || {});
    return exclusive(opts.appId, deps, async () => {
      const cfg = readCfg(opts.appId, deps);
      if (!cfg.enabled) return { state: "notsent", reason: "연동이 꺼져 있음" };
      const g = guardStop(opts, cfg);
      if (g) return { state: "notsent", reason: g };
      if (!testIdAllowed(opts.id, opts.studentsInfo)) return { state: "notsent", reason: "실험용 학번이 아니거나 실제 명단에 있음" };
      if (opts.type !== "A" && opts.type !== "B") return { state: "notsent", reason: "유형 오류" };
      const secrets = [cfg.code];
      const tk = await getToken(cfg.code, deps);
      if (!tk.ok) return { state: "notsent", reason: `토큰을 받지 못함: ${redact(tk.reason, secrets)}` };
      secrets.push(tk.token);
      const v = await sendAct({ code: cfg.code, token: tk.token, id: opts.id, date: opts.date, time: opts.time, teacher: cfg.teacher, place: opts.place, memo: TEST_MEMO, type: opts.type }, deps);
      return { state: v.state, reason: redact(v.reason, secrets) };
    });
  }

  // 사용자가 온웨이에듀 화면에서 들어간 것을 확인한 "확인 필요" 학생 — ok_manual로. 보내기와 같은 잠금 아래에서만(보내는 중이면 "busy")
  async function markManualOk(appId, date, id, type, depsIn) {
    const deps = Object.assign(defaultDeps(), depsIn || {});
    const out = await exclusive(appId, deps, async () => {
      const r = readLog(appId, date, deps);
      return { ok: r.ok && writeLog(appId, date, setEntry(r.log, id, type, "ok_manual", "온웨이에듀 화면에서 확인함", deps.now()), deps) };
    });
    return out.busy ? "busy" : out.ok === true;
  }

  function prune(ctx, depsIn) {
    const deps = Object.assign(defaultDeps(), depsIn || {});
    try {
      const keys = [];
      for (let i = 0; i < deps.storage.length; i++) keys.push(deps.storage.key(i));
      const sess = ctx.session ? ctx.session().currentDateStr : null;
      for (const k of pruneKeys(keys, ctx.appId, ctx.today(), sess, LOG_KEEP_DAYS)) deps.storage.removeItem(k);
    } catch (e) {}
  }

  // ---------- 화면(DOM은 글자로만 넣는다 — 학생 이름·서버 문자열을 HTML로 해석하지 않음) ----------
  function el(tag, attrs, ...kids) {
    const d = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "style") d.style.cssText = v;
      else if (k === "onclick" || k === "onchange" || k === "oninput") d[k] = v;
      else if (v !== false && v != null) d.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids) if (c != null) d.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return d;
  }
  const BTN = "display:block; width:100%; padding:13px; border:none; border-radius:10px; font-size:15px; font-weight:bold; color:#fff; margin-bottom:8px; cursor:pointer;";
  const INPUT = "width:100%; padding:10px; border:1.5px solid #cbd5e0; border-radius:8px; margin:6px 0 12px; box-sizing:border-box; font-size:14px; -webkit-user-select:text; user-select:text; touch-action:auto;";
  const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const nowHHMM = () => { const d = new Date(); return floor5(d.getHours(), d.getMinutes()); };

  // 기록/백업 관리 창 안의 설정 칸
  function renderSettings(container, ctx) {
    if (!container) return;
    const deps = defaultDeps();
    container.textContent = "";
    const box = el("div", { style: "background:#f3f0ff; padding:15px; border-radius:10px; border:1px solid #c5b8f5; margin-bottom:15px;" });
    container.appendChild(box);
    const draw = (msg) => {
      box.textContent = "";
      const cfg = readCfg(ctx.appId, deps);
      box.appendChild(el("div", { style: "font-weight:900; color:#5f3dc4; margin-bottom:8px; font-size:16px; text-align:center;" }, "🔗 온웨이에듀 벌점 연동"));
      box.appendChild(el("div", { style: "font-size:12px; color:#5a6b7b; text-align:center; margin-bottom:10px; line-height:1.6;" },
        cfg.enabled ? `켜짐 · 사감 ${cfg.teacher} · 코드 저장됨(${maskCode(cfg.code)})` : "꺼짐 — 지금까지와 똑같이 동작합니다(온웨이에듀로 보내지 않음)"));
      if (msg) box.appendChild(el("div", { style: "font-size:13px; color:#c92a2a; text-align:center; margin-bottom:10px; font-weight:bold;" }, msg));
      const panel = el("div", { style: "display:none; margin-top:4px; background:#fff; border:1px solid #d0d8e0; border-radius:10px; padding:14px; text-align:left;" });
      box.appendChild(el("button", { style: BTN + "background:#74808d; margin-bottom:0;", onclick: () => { panel.style.display = panel.style.display === "none" ? "block" : "none"; } }, "⚙️ 연동 설정 열기 / 닫기"));
      box.appendChild(panel);
      panel.appendChild(el("div", { style: "font-size:12px; color:#5a6b7b; line-height:1.6; margin-bottom:10px;" },
        "점호 태블릿이 여러 대면 다른 태블릿 기록을 모두 합치는 한 대에서만 켜세요. 브라우저 데이터를 지우면 보낸 기록도 사라집니다 — 지우기 전에 온웨이에듀 화면을 확인하세요."));
      panel.appendChild(el("label", { style: "font-size:13px; font-weight:bold; color:#2c3e50;" }, "비밀 코드(업체에서 받은 코드)"));
      const code = el("input", { type: "password", autocomplete: "new-password", placeholder: cfg.code ? `저장됨(${maskCode(cfg.code)}) — 바꿀 때만 입력` : "업체에서 받은 코드", style: INPUT });
      panel.appendChild(code);
      panel.appendChild(el("label", { style: "font-size:13px; font-weight:bold; color:#2c3e50;" }, "사감 이름(온웨이에듀에 등록된 이름과 똑같이)"));
      const teacher = el("input", { type: "text", autocomplete: "off", value: cfg.teacher, style: INPUT });
      panel.appendChild(teacher);
      const save = (enable) => {
        const cur = readCfg(ctx.appId, deps);
        const next = { enabled: enable, code: code.value.trim() ? code.value.trim() : cur.code, teacher: teacher.value.trim() };
        if (enable && !canEnable(next)) return draw("켜려면 비밀 코드와 사감 이름이 모두 있어야 합니다");
        if (!writeCfg(ctx.appId, next, deps)) return draw("설정을 저장하지 못했습니다(저장 공간 확인)");
        draw(enable ? "연동을 켰습니다" : "저장했습니다(연동 꺼짐)");
      };
      panel.appendChild(el("button", { style: BTN + "background:#2b8a3e;", onclick: () => save(true) }, "✅ 저장하고 켜기"));
      panel.appendChild(el("button", { style: BTN + "background:#868e96;", onclick: () => save(false) }, "⏸ 저장하고 끄기"));
      panel.appendChild(el("button", { style: BTN + "background:#c92a2a;", onclick: () => {
        if (!confirm("온웨이에듀 연동 설정(비밀 코드·사감 이름)을 지울까요?\n보낸 기록은 남깁니다(같은 학생에게 다시 보내지 않도록).")) return;
        try { deps.storage.removeItem(cfgKey(ctx.appId)); draw("설정을 지웠습니다(연동 꺼짐)"); } catch (e) { draw("설정을 지우지 못했습니다"); }
      } }, "🗑 설정 지우기"));
      if (cfg.enabled) panel.appendChild(testSection(ctx, deps));
    };
    draw("");
  }

  function testSection(ctx, deps) {
    const wrap = el("div", { style: "border-top:2px dashed #c5b8f5; margin-top:10px; padding-top:12px;" });
    wrap.appendChild(el("div", { style: "font-weight:bold; color:#5f3dc4; margin-bottom:6px;" }, "🧪 시험 보내기(실험용 학번만)"));
    wrap.appendChild(el("div", { style: "font-size:12px; color:#5a6b7b; line-height:1.6; margin-bottom:8px;" }, `실험용 학번 ${TEST_IDS.join("·")}에만 벌점 한 건을 보냅니다. 보낸 뒤 온웨이에듀 화면에서 확인하세요.`));
    let pickId = TEST_IDS[0], pickType = "A";
    const idRow = el("div", { style: "display:flex; gap:6px; margin-bottom:8px;" });
    const typeRow = el("div", { style: "display:flex; gap:6px; margin-bottom:8px;" });
    const paint = () => {
      for (const b of idRow.children) b.style.background = b.dataset.v === pickId ? "#5f3dc4" : "#adb5bd";
      for (const b of typeRow.children) b.style.background = b.dataset.v === pickType ? "#5f3dc4" : "#adb5bd";
    };
    for (const id of TEST_IDS) idRow.appendChild(el("button", { "data-v": id, style: BTN + "flex:1; margin:0;", onclick: () => { pickId = id; paint(); } }, id));
    for (const t of ["A", "B"]) typeRow.appendChild(el("button", { "data-v": t, style: BTN + "flex:1; margin:0;", onclick: () => { pickType = t; paint(); } }, TYPE_NAME[t]));
    wrap.appendChild(idRow);
    wrap.appendChild(typeRow);
    paint();
    const out = el("div", { style: "font-size:13px; line-height:1.6; margin-top:6px; font-weight:bold;" });
    const go = el("button", { style: BTN + "background:#5f3dc4;", onclick: async () => {
      const sess = ctx.session();
      if (!testIdAllowed(pickId, sess.studentsInfo)) { out.textContent = "이 학번은 실제 명단에 있어 시험 보내기를 할 수 없습니다"; return; }
      const cfg = readCfg(ctx.appId, deps);
      const date = ctx.today();
      const time = nowHHMM();
      if (!confirm(`시험 보내기\n\n실험용 학번 ${pickId} · ${TYPE_NAME[pickType]}\n사감 ${cfg.teacher} · 장소 ${ctx.place}\n${date} ${time}\n\n보낼까요?`)) return;
      // 확인 창을 띄워 둔 사이 5분 구간·날짜가 바뀌었으면 보낸 값이 본 값과 달라진다 — 다시 누르게(감사실장 P3)
      if (ctx.today() !== date || nowHHMM() !== time) { out.textContent = "시간이 바뀌었습니다 — [시험 보내기]를 다시 눌러 주세요"; return; }
      go.disabled = true; out.textContent = "보내는 중…";
      try {
        const r = await runTestSend({ appId: ctx.appId, id: pickId, type: pickType, date, time, place: ctx.place, studentsInfo: sess.studentsInfo, today: ctx.today, expect: { code: cfg.code, teacher: cfg.teacher } }, deps);
        out.textContent = r.busy ? "다른 곳에서 보내는 중입니다" : r.state === "ok" ? `✅ 완료 — 온웨이에듀에서 ${pickId} 학생 기록을 확인하세요` : r.state === "fail" ? `❌ 거절됨: ${r.reason}` : r.state === "unknown" ? `⚠️ 확인 필요(${r.reason}) — 온웨이에듀 화면에서 들어갔는지 확인하세요` : `보내지 않음: ${r.reason}`;
      } catch (e) {
        out.textContent = "⚠️ 확인 필요 — 온웨이에듀 화면에서 들어갔는지 확인하세요";
      } finally { go.disabled = false; }
    } }, "🧪 시험 보내기");
    wrap.appendChild(go);
    wrap.appendChild(out);
    return wrap;
  }

  // 점호 종료 결과 화면 아래 단추 — 켜져 있을 때만
  function attachResultButton(container, ctx) {
    if (!container) return;
    const cfg = readCfg(ctx.appId, defaultDeps());
    if (!cfg.enabled) return;
    container.appendChild(el("div", { style: "border-top:2px solid #5f3dc4; padding-top:12px; margin-top:10px;" },
      el("button", { style: BTN + "background:#5f3dc4; margin:0;", onclick: () => openConfirm(ctx) }, "🔗 온웨이에듀로 보내기")));
  }

  const STATE_TEXT = { ok: "✅ 완료", ok_manual: "✅ 완료(확인)", fail: "❌ 거절됨", unknown: "⚠️ 확인 필요", notsent: "⏸ 미전송", skipped: "↷ 건너뜀" };

  function openConfirm(ctx) {
    const deps = defaultDeps();
    // 앱의 뒤로 가기 가드는 문서 앞쪽에서 처음 찾은 열린 .modal 하나만 닫는다 — 이 창을 .modal로 문서 맨 앞에 두어 가드가 이 창만 닫게 하고
    // (뒤의 결과 화면은 그대로), 가드 다음에 도는 아래 처리기가 보내는 중이면 다시 보이게·아니면 치운다(Gemini P3 → 감사실장 P3)
    const overlay = el("div", { class: "modal", style: "display:flex; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:2000; justify-content:center; align-items:center;" });
    const card = el("div", { class: "scrollable-content", style: "background:#fff; border-radius:15px; width:92%; max-width:480px; max-height:88vh; overflow-y:auto; padding:20px; font-size:15px; line-height:1.5; touch-action:pan-y;" });
    overlay.appendChild(card);
    document.body.insertBefore(overlay, document.body.firstChild);
    let busy = false;
    const onPop = () => {
      if (!overlay.isConnected || overlay.style.display === "flex") return; // 가드가 이 창이 아닌 다른 창을 닫음
      if (busy) overlay.style.display = "flex";
      else close();
    };
    const close = () => { if (busy) return; overlay.remove(); window.removeEventListener("popstate", onPop); };
    window.addEventListener("popstate", onPop);
    const closeBtn = () => el("button", { style: BTN + "background:#a0aec0; margin-top:12px;", onclick: close }, "닫기");
    const sess = ctx.session();
    const t = ctx.times();
    const today = ctx.today();
    const date = sess.currentDateStr;
    const cfg = readCfg(ctx.appId, deps);
    const lateTime = floor5(t.lateH, t.lateM), endTime = floor5(t.endH, t.endM);
    card.appendChild(el("h2", { style: "margin:0 0 10px; color:#5f3dc4; font-size:19px; text-align:center;" }, "🔗 온웨이에듀로 보내기"));
    const stop = (msg) => { card.appendChild(el("div", { style: "color:#c92a2a; font-weight:bold; margin:10px 0;" }, msg)); card.appendChild(closeBtn()); };
    if (!cfg.enabled) return stop("연동이 꺼져 있습니다.");
    if (date !== today) return stop(`점호 날짜(${date})가 오늘(${today})이 아니라 보낼 수 없습니다.`);
    if (!lateTime || !endTime) return stop("기준 시간 설정을 확인해 주세요.");
    const read = readLog(ctx.appId, date, deps);
    if (!read.ok) return stop("보낸 기록을 읽지 못해 보낼 수 없습니다(저장 공간을 확인해 주세요).");
    const tg = buildTargets({ studentsInfo: sess.studentsInfo, absentList: sess.absentList, attendanceLog: sess.attendanceLog, sessionDate: date, today, nowMinutes: nowMinutes(), endMinutes: Number(t.endH) * 60 + Number(t.endM) });
    const info = sess.studentsInfo || {};
    const label = (id) => `${id} ${info[id] ? info[id].name : ""}${info[id] && info[id].room ? `(${info[id].room}호)` : ""}`;
    card.appendChild(el("div", { style: "background:#f8f9fa; border-radius:10px; padding:10px; font-size:14px; margin-bottom:10px;" },
      el("div", {}, `날짜 ${date} · 사감 ${cfg.teacher}`),
      el("div", {}, `장소 ${ctx.place} · 지각 ${lateTime} · 불참 ${endTime}`),
      el("div", { style: "font-weight:bold;" }, `점호완료 ${tg.done}명 / 대상 ${tg.target}명`)));
    const syncBox = el("input", { type: "checkbox", style: "width:20px; height:20px; flex:none;" });
    card.appendChild(el("label", { style: "display:flex; gap:8px; align-items:center; background:#fff4e6; border:1px solid #ffc078; border-radius:8px; padding:10px; margin-bottom:10px; font-weight:bold; color:#d9480f;" },
      syncBox, "다른 태블릿의 점호 기록을 동기화(가져오기)로 모두 합쳤습니다"));
    const rows = []; // { id, type, kind, box, missing }
    const manualBtns = []; // [들어갔음 확인] — 보내는 동안 잠근다(감사실장 P2)
    const now = deps.now();
    const section = (title, ids, type, missing) => {
      if (!ids.length) return;
      card.appendChild(el("div", { style: `font-weight:900; margin:10px 0 4px; color:${type === "A" ? "#e67700" : "#c92a2a"};` }, `${title} ${ids.length}명`));
      for (const id of ids) {
        const st = rowStatus(read.log, id, type, now);
        const box = el("input", { type: "checkbox", style: "width:20px; height:20px; flex:none;" });
        box.checked = st.checked; box.disabled = !st.selectable;
        const tag = st.kind === "sent" ? " · 보냄" : st.kind === "sending" ? " · 보내는 중" : st.kind === "unknown" ? " · ⚠️ 확인 필요(온웨이에듀에서 들어갔는지 확인 후 다시 보내기)" : st.kind === "fail" ? " · 전에 거절됨" : st.kind === "other" ? ` · ⚠️ 이미 ${TYPE_NAME[st.otherType]} 보냄` : "";
        const line = el("label", { style: `display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid #f1f3f5; ${st.selectable ? "" : "color:#adb5bd;"}` }, box, el("span", {}, label(id) + tag));
        card.appendChild(line);
        if (st.kind === "unknown") {
          const mb = el("button", { style: "margin:2px 0 6px 28px; padding:6px 10px; border:1px solid #2b8a3e; background:#fff; color:#2b8a3e; border-radius:8px; font-size:13px;", onclick: async () => {
            if (busy) return;
            if (!confirm(`${label(id)} — 온웨이에듀 화면에서 ${TYPE_NAME[type]} 벌점이 들어간 것을 확인했나요?\n확인하면 다시 보내지 않습니다.`)) return;
            const r = await markManualOk(ctx.appId, date, id, type, deps);
            if (r === true) { box.checked = false; box.disabled = true; mb.textContent = "✅ 들어갔음으로 표시함"; mb.disabled = true; update(); }
            else alert(r === "busy" ? "다른 곳에서 보내는 중이라 지금은 표시할 수 없습니다" : "기록하지 못했습니다(저장 공간 확인)");
          } }, "들어갔음 확인");
          manualBtns.push(mb);
          card.appendChild(mb);
        }
        rows.push({ id, type, kind: st.kind, box, missing });
        box.onchange = () => update();
      }
    };
    section("[지각]", tg.late, "A", false);
    section("[불참 — 늦게 입력]", tg.absentEntered, "B", false);
    section("[불참 — 미입력]", tg.absentMissing, "B", true);
    if (tg.missingBlocked && tg.missingCount > 0) {
      const why = tg.missingBlocked === "not-today" ? "점호 날짜가 오늘이 아님" : tg.missingBlocked === "before-end" ? "아직 불참 처리 시간 전" : "점호완료가 대상의 절반 미만 — 기록이 비었거나 다른 태블릿 기록이 합쳐지지 않았을 수 있음";
      card.appendChild(el("div", { style: "margin:10px 0; color:#c92a2a; font-size:13px; font-weight:bold;" }, `미입력 ${tg.missingCount}명은 보내지 않습니다: ${why}`));
    }
    if (tg.excluded.length) card.appendChild(el("div", { style: "margin:10px 0; color:#868e96; font-size:13px;" }, `제외 ${tg.excluded.length}명: ${tg.excluded.map((x) => `${x.id}(${x.why})`).join(", ")}`));
    const sendBtn = el("button", { style: BTN + "background:#5f3dc4; margin-top:12px;" }, "보내기");
    card.appendChild(sendBtn);
    const progress = el("div", { style: "font-weight:bold; color:#5f3dc4; margin-top:6px;" });
    card.appendChild(progress);
    const closeB = closeBtn();
    card.appendChild(closeB);
    const chosen = () => rows.filter((r) => r.box.checked && !r.box.disabled);
    function update() {
      const sel = chosen();
      sendBtn.textContent = `${sel.length}명 보내기`;
      sendBtn.disabled = busy || !syncBox.checked || sel.length === 0;
      sendBtn.style.opacity = sendBtn.disabled ? "0.45" : "1";
    }
    syncBox.onchange = update;
    update();
    sendBtn.onclick = async () => {
      update();
      if (sendBtn.disabled) return;
      const sel = chosen();
      const again = sel.filter((r) => r.kind === "unknown" || r.kind === "other").length;
      const missingN = sel.filter((r) => r.missing).length;
      if (!confirm(`${sel.length}명에게 벌점을 보냅니다.${missingN ? `\n(미입력 불참 ${missingN}명 포함 — 다른 태블릿 기록을 모두 합쳤는지 다시 확인하세요)` : ""}\n실제 학생 기록에 들어가고 되돌리는 기능이 없습니다.${again ? `\n(확인 필요·다른 유형 보냄이었던 ${again}명 포함)` : ""}\n\n보낼까요?`)) return;
      if (ctx.today() !== date) { alert("날짜가 바뀌었습니다(자정이 지남) — 확인 창을 다시 열어 주세요"); return; }
      busy = true; update();
      closeB.disabled = true; closeB.style.opacity = "0.45";
      for (const r of rows) r.box.disabled = true;
      for (const b of manualBtns) b.disabled = true;
      syncBox.disabled = true;
      const items = sel.map((r) => ({ id: r.id, type: r.type, decided: r.kind, time: r.type === "A" ? lateTime : endTime }));
      let out;
      try {
        out = await runSend({ appId: ctx.appId, date, place: ctx.place, items, today: ctx.today, expect: { code: cfg.code, teacher: cfg.teacher }, onProgress: (k, n) => { progress.textContent = `보내는 중 ${k}/${n}…`; } });
      } catch (e) {
        out = { results: [], stopped: "보내는 중 오류가 나 멈췄습니다 — 온웨이에듀 화면에서 확인해 주세요" };
      }
      busy = false;
      showResult(card, out, label, closeB);
    };
  }

  function showResult(card, out, label, closeB) {
    card.textContent = "";
    card.appendChild(el("h2", { style: "margin:0 0 10px; color:#5f3dc4; font-size:19px; text-align:center;" }, "🔗 보내기 결과"));
    if (out.busy) {
      card.appendChild(el("div", { style: "color:#c92a2a; font-weight:bold;" }, "다른 창에서 보내는 중이라 보내지 않았습니다."));
    } else {
      const res = out.results || [];
      const count = (s) => res.filter((r) => r.state === s).length;
      card.appendChild(el("div", { style: "background:#f8f9fa; border-radius:10px; padding:10px; margin-bottom:10px; font-weight:bold;" },
        `완료 ${count("ok")} · 거절됨 ${count("fail")} · 확인 필요 ${count("unknown")} · 미전송 ${count("notsent")} · 건너뜀 ${count("skipped")}`));
      if (out.stopped) card.appendChild(el("div", { style: "color:#c92a2a; font-weight:bold; margin-bottom:10px;" }, out.stopped));
      for (const r of res) {
        card.appendChild(el("div", { style: "padding:5px 0; border-bottom:1px solid #f1f3f5; font-size:14px;" },
          `${STATE_TEXT[r.state] || r.state} · ${TYPE_NAME[r.type] || ""} · ${label(r.id)}${r.reason ? ` — ${r.reason}` : ""}`));
      }
    }
    closeB.disabled = false; closeB.style.opacity = "1";
    card.appendChild(closeB);
  }

  const api = {
    API_BASE, TEST_IDS, MEMO, TEST_MEMO,
    floor5, validStudentId, buildTargets, judgeAct, judgeToken, isTokenError, redact, parseCfg, canEnable, maskCode, parseLog,
    effectiveState, rowStatus, mayStart, setEntry, pruneKeys, testIdAllowed, cfgKey, logKey,
    runSend, runTestSend, markManualOk, prune, readCfg, writeCfg, readLog,
    renderSettings, attachResultButton, openConfirm,
  };
  root.OnwayEdu = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
