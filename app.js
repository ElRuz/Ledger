import React, { useState, useEffect, useRef, useMemo } from "react";
import ReactDOM from "react-dom/client";
import {
  Mic, Plus, Check, Clock, MessageSquare, Wallet, Zap, List, FileText,
  Upload, X, Trash2, Send, AlertTriangle, Loader2, ChevronRight,
  Pencil, Eye, EyeOff, Lock, ArrowDownLeft, ArrowUpRight, Shield
} from "lucide-react";

/* ================= constants & helpers ================= */

const MODEL = "claude-sonnet-4-6";
const KEY = "ledger:v2";
// AI calls point here. This has no key and will fail closed (CORS) until a backend
// proxy is wired up — every caller already falls back to manual entry when it fails.
const API_URL = "https://api.anthropic.com/v1/messages";

const DEFAULT_CATEGORIES = [
  "Housing", "Utilities", "Subscriptions", "Insurance",
  "Food", "Transport", "Health", "Debt", "Other",
];
const INCOME_CATEGORIES = ["Salary", "Freelance", "Refund", "Gift", "Other income"];

const uid = () => Math.random().toString(36).slice(2, 10);
const iso = (d = new Date()) => d.toISOString().slice(0, 10);
const today = () => new Date(new Date().toDateString());

function daysUntil(d) {
  if (!d) return null;
  return Math.round((new Date(d + "T00:00:00") - today()) / 86400000);
}
function fmt(n) {
  if (n == null || n === "") return null;
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function addMonths(d, n) {
  const x = new Date(d + "T00:00:00"); x.setMonth(x.getMonth() + n); return iso(x);
}
function shiftDays(d, n) {
  const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return iso(x);
}
function urgency(o) {
  if (o.done) return "done";
  const d = daysUntil(o.due);
  if (d == null) return "someday";
  if (d < 0) return "overdue";
  if (d <= 3) return "soon";
  if (d <= 14) return "week";
  return "later";
}
const DOT = {
  overdue: "bg-rose-500", soon: "bg-amber-400", week: "bg-sky-400",
  later: "bg-slate-500", someday: "bg-slate-600", done: "bg-emerald-500",
};
const TXT = {
  overdue: "text-rose-300", soon: "text-amber-300", week: "text-sky-300",
  later: "text-slate-400", someday: "text-slate-400", done: "text-emerald-400",
};

/* ================= Claude ================= */

async function callClaude(messages, system) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages }),
  });
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("\n");
}
function parseJSON(text) {
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const i = clean.search(/[{[]/);
  return JSON.parse(i > 0 ? clean.slice(i) : clean);
}

/* ================= local credential detection ================= */
/* Runs entirely on-device. Sensitive notes never reach the API. */

const SECRET_WORDS = /\b(password|passwd|passcode|pass phrase|passphrase|pin|api[ -]?key|secret key|secret|token|seed phrase|recovery phrase|private key|2fa|otp|security code|login|credentials?|account number|routing number|ssn|social security)\b/i;

function looksSensitive(text) {
  if (SECRET_WORDS.test(text)) return true;
  // "something: X7#kd9!" — a colon followed by a high-entropy string
  return /:\s*\S*(?=\S*[A-Z])(?=\S*[0-9])(?=\S*[^A-Za-z0-9])\S{7,}/.test(text);
}
function guessService(text) {
  const m = text.match(/^\s*([A-Za-z][\w .-]{1,24}?)\s*(?:wifi|wi-fi|password|login|account|:|-)/i);
  if (m) return m[1].trim().replace(/\s+/g, " ");
  const first = text.trim().split(/\s+/)[0];
  return first ? first.replace(/[^\w-]/g, "") : "Untitled";
}
function maskSecrets(text) {
  return text.replace(/((?:password|passcode|pin|key|token|secret|login)\s*[:=-]\s*)(\S+)/gi,
    (_, p, v) => p + "•".repeat(Math.min(v.length, 12)));
}

/* ================= rules ================= */

const WHEN_OPTIONS = [
  { id: "daysBefore", label: "a bill is __ days from due and unpaid", unit: "days", def: 3 },
  { id: "snoozed", label: "something has been snoozed __ times", unit: "times", def: 3 },
  { id: "overBudget", label: "a spending category passes $__", unit: "$", def: 200 },
  { id: "lowNet", label: "money out exceeds money in by $__", unit: "$", def: 0 },
];
const THEN_OPTIONS = [
  { id: "notify", label: "put it at the top of my day" },
  { id: "discuss", label: "have the agent talk it through with me" },
  { id: "draft", label: "draft a cancellation or follow-up message" },
];

function evaluateRules(s) {
  const out = [];
  const spend = s.transactions.filter((t) => t.direction === "out");
  const income = s.transactions.filter((t) => t.direction === "in");
  for (const r of s.rules) {
    if (r.when === "daysBefore")
      for (const o of s.obligations) {
        const d = daysUntil(o.due);
        if (!o.done && d != null && d >= 0 && d <= r.value)
          out.push({ id: r.id + o.id, then: r.then, text: `${o.title} is due in ${d} day${d === 1 ? "" : "s"}` });
      }
    if (r.when === "snoozed")
      for (const o of s.obligations)
        if (!o.done && (o.snoozes || 0) >= r.value)
          out.push({ id: r.id + o.id, then: r.then, text: `${o.title} has been pushed ${o.snoozes} times` });
    if (r.when === "overBudget") {
      const m = {};
      for (const t of spend) m[t.category] = (m[t.category] || 0) + Math.abs(t.amount);
      for (const [c, v] of Object.entries(m))
        if (v > r.value) out.push({ id: r.id + c, then: r.then, text: `${c} is at ${fmt(v)}` });
    }
    if (r.when === "lowNet") {
      const net = income.reduce((a, t) => a + Math.abs(t.amount), 0)
        - spend.reduce((a, t) => a + Math.abs(t.amount), 0);
      if (-net > r.value)
        out.push({ id: r.id, then: r.then, text: `You're ${fmt(-net)} in the red` });
    }
  }
  return out;
}

/* ================= storage ================= */

const BLANK = {
  obligations: [], transactions: [], notes: [],
  categories: DEFAULT_CATEGORIES, incomeCategories: INCOME_CATEGORIES, rules: [],
};
const load = async () => {
  try { const v = localStorage.getItem(KEY); return v ? { ...BLANK, ...JSON.parse(v) } : BLANK; }
  catch { return BLANK; }
};
const save = async (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { console.error(e); } };

/* ================= voice ================= */

function useVoice(onResult) {
  const ref = useRef(null);
  const [listening, setListening] = useState(false);
  const supported = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const start = () => {
    if (!supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = false;
    rec.onresult = (e) => onResult(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    ref.current = rec; rec.start(); setListening(true);
  };
  return { supported, listening, start, stop: () => { ref.current?.stop(); setListening(false); } };
}

/* ================= shared UI ================= */

function Btn({ children, onClick, icon: Icon, accent }) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border ${
        accent ? "border-amber-500 text-amber-300" : "border-slate-700 text-slate-300"}`}>
      {Icon && <Icon className="w-3.5 h-3.5" />}{children}
    </button>
  );
}
function Field({ label, children }) {
  return (
    <div className="mb-3">
      <label className="block text-xs text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}
const inputCls = "w-full bg-slate-800 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none";

function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-slate-900 z-20 flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
        <span className="text-sm font-medium">{title}</span>
        <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </div>
  );
}

/* ================= app ================= */

export default function App() {
  const [state, setState] = useState(BLANK);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("now");
  const [agent, setAgent] = useState(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => { load().then((s) => { setState(s); setReady(true); }); }, []);
  useEffect(() => { if (ready) save(state); }, [state, ready]);

  const update = (fn) => setState((s) => fn({ ...s }));
  const alerts = useMemo(() => (ready ? evaluateRules(state) : []), [state, ready]);

  if (!ready)
    return <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <Loader2 className="w-5 h-5 text-slate-500 animate-spin" /></div>;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col"
         style={{ fontVariantNumeric: "tabular-nums" }}>
      <header className="px-5 pt-6 pb-3 border-b border-slate-800 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Ledger</h1>
        <span className="text-xs text-slate-500">
          {today().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto pb-28">
        {tab === "now" && <NowView {...{ state, update, alerts }} openAgent={setAgent} edit={setEditing} />}
        {tab === "money" && <MoneyView {...{ state, update }} />}
        {tab === "notes" && <NotesView {...{ state, update }} />}
        {tab === "rules" && <RulesView {...{ state, update }} />}
      </main>

      <AddBar {...{ state, update }} openAgent={setAgent} />

      <nav className="fixed bottom-0 inset-x-0 bg-slate-900 border-t border-slate-800 flex">
        {[
          { id: "now", icon: List, label: "Now" },
          { id: "money", icon: Wallet, label: "Money" },
          { id: "notes", icon: FileText, label: "Notes" },
          { id: "rules", icon: Zap, label: "Rules" },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 py-3 flex flex-col items-center gap-1 text-xs ${
              tab === t.id ? "text-slate-100" : "text-slate-500"}`}>
            <t.icon className="w-4 h-4" />{t.label}
          </button>
        ))}
      </nav>

      {editing && (
        <EditObligation item={editing} state={state}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            update((s) => { s.obligations = s.obligations.map((o) => o.id === next.id ? next : o); return s; });
            setEditing(null);
          }} />
      )}
      {agent && <AgentSheet seed={agent} {...{ state, update }} onClose={() => setAgent(null)} />}
    </div>
  );
}

/* ================= now ================= */

function NowView({ state, update, alerts, openAgent, edit }) {
  const items = [...state.obligations].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });

  const soon = state.obligations
    .filter((o) => !o.done && o.amount && daysUntil(o.due) != null && daysUntil(o.due) <= 14)
    .reduce((s, o) => s + Number(o.amount), 0);

  const complete = (o) => update((s) => {
    s.obligations = s.obligations.map((x) => x.id !== o.id ? x
      : x.recurring ? { ...x, due: addMonths(x.due, 1), snoozes: 0 } : { ...x, done: true });
    return s;
  });
  const snooze = (o) => update((s) => {
    s.obligations = s.obligations.map((x) => x.id === o.id
      ? { ...x, due: shiftDays(x.due || iso(), 2), snoozes: (x.snoozes || 0) + 1 } : x);
    return s;
  });

  return (
    <div>
      <div className="px-5 py-6 border-b border-slate-800">
        <div className="text-3xl font-semibold">{fmt(soon) || "$0.00"}</div>
        <div className="text-sm text-slate-400 mt-1">leaving your account in the next two weeks</div>
      </div>

      {alerts.length > 0 && (
        <div className="px-5 py-4 border-b border-slate-800 space-y-2">
          {alerts.slice(0, 4).map((a) => (
            <button key={a.id}
              onClick={() => a.then !== "notify" && openAgent({
                seed: `About "${a.text}" — help me work out what to do.` })}
              className="w-full flex items-start gap-3 text-left bg-slate-800 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span className="text-sm flex-1">{a.text}</span>
              {a.then !== "notify" && <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
            </button>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <p className="px-5 py-16 text-center text-slate-400 text-sm">
          Nothing tracked yet. Say or type below — "electric bill, $95, due the 14th, every month."
        </p>
      ) : (
        <ul>
          {items.map((o) => {
            const u = urgency(o), d = daysUntil(o.due);
            return (
              <li key={o.id} className="px-5 py-4 border-b border-slate-800 flex gap-3">
                <span className={`w-2 h-2 rounded-full mt-2 shrink-0 ${DOT[u]}`} />
                <div className="flex-1 min-w-0">
                  <button onClick={() => edit(o)} className="w-full text-left">
                    <div className="flex justify-between gap-3">
                      <span className={`text-sm ${o.done ? "line-through text-slate-500" : ""}`}>{o.title}</span>
                      {o.amount != null && <span className="text-sm shrink-0">{fmt(o.amount)}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 mt-1 text-xs text-slate-500">
                      <span className={TXT[u]}>
                        {u === "overdue" ? `${Math.abs(d)}d late` : d != null ? `in ${d}d` : "no date"}
                      </span>
                      {o.category && <span>· {o.category}</span>}
                      {o.recurring && <span>· monthly</span>}
                      {(o.snoozes || 0) > 0 && <span>· pushed {o.snoozes}×</span>}
                    </div>
                  </button>
                  {!o.done && (
                    <div className="flex gap-2 mt-3">
                      <Btn onClick={() => complete(o)} icon={Check}>Done</Btn>
                      <Btn onClick={() => snooze(o)} icon={Clock}>+2d</Btn>
                      <Btn onClick={() => edit(o)} icon={Pencil}>Edit</Btn>
                      {(o.snoozes || 0) >= 3 && (
                        <Btn accent icon={MessageSquare} onClick={() => openAgent({
                          seed: `I've pushed "${o.title}" ${o.snoozes} times. Help me deal with it.` })}>
                          Talk it out
                        </Btn>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ================= edit ================= */

function EditObligation({ item, state, onSave, onClose }) {
  const [d, setD] = useState({ ...item, amount: item.amount ?? "" });
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));

  return (
    <Sheet title="Edit" onClose={onClose}>
      <Field label="What is it">
        <input className={inputCls} value={d.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label="Amount">
        <input className={inputCls} type="number" inputMode="decimal" value={d.amount}
          placeholder="leave blank if it isn't money"
          onChange={(e) => set("amount", e.target.value)} />
      </Field>
      <Field label="Due">
        <input className={inputCls} type="date" value={d.due || ""} onChange={(e) => set("due", e.target.value)} />
      </Field>
      <Field label="Category">
        <select className={inputCls} value={d.category || "Other"} onChange={(e) => set("category", e.target.value)}>
          {state.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <button onClick={() => set("recurring", !d.recurring)}
        className="flex items-center gap-2 text-sm mb-6">
        <span className={`w-4 h-4 rounded border flex items-center justify-center ${
          d.recurring ? "bg-slate-100 border-slate-100" : "border-slate-600"}`}>
          {d.recurring && <Check className="w-3 h-3 text-slate-900" />}
        </span>
        Repeats every month
      </button>
      <div className="flex gap-2">
        <button onClick={() => onSave({ ...d, amount: d.amount === "" ? null : Number(d.amount) })}
          className="flex-1 py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium">
          Save changes
        </button>
        <button onClick={onClose} className="px-4 rounded-lg border border-slate-700 text-sm">Cancel</button>
      </div>
    </Sheet>
  );
}

/* ================= money ================= */

function MoneyView({ state, update }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [newCat, setNewCat] = useState("");
  const [editTx, setEditTx] = useState(null);
  const [draft, setDraft] = useState({ merchant: "", amount: "", direction: "out", category: "Food", date: iso() });

  const inTotal = state.transactions.filter((t) => t.direction === "in")
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const outTotal = state.transactions.filter((t) => t.direction === "out")
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const net = inTotal - outTotal;

  const byCat = useMemo(() => {
    const m = {};
    for (const t of state.transactions.filter((x) => x.direction === "out"))
      m[t.category] = (m[t.category] || 0) + Math.abs(t.amount);
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [state.transactions]);

  const addManual = () => {
    if (!draft.merchant.trim() || !draft.amount) return;
    update((s) => {
      s.transactions.push({ ...draft, id: uid(), amount: Number(draft.amount), recurring: false });
      return s;
    });
    setDraft({ ...draft, merchant: "", amount: "" });
  };

  async function readStatement() {
    if (!raw.trim()) return;
    setBusy(true); setErr("");
    try {
      const out = await callClaude(
        [{ role: "user", content: `Statement text:\n\n${raw.slice(0, 6000)}` }],
        `Extract every transaction from this bank or card statement text.
direction is "in" for deposits, paychecks, refunds and credits; "out" for purchases and payments.
amount is always a positive number.
Expense categories: ${state.categories.join(", ")}.
Income categories: ${state.incomeCategories.join(", ")}.
Set recurring:true when the merchant looks like a subscription or a fixed monthly bill.
Return ONLY JSON, no prose:
{"transactions":[{"date":"YYYY-MM-DD","merchant":"","amount":0,"direction":"out","category":"","recurring":false}]}`
      );
      const txs = (parseJSON(out).transactions || []).map((t) => ({ ...t, id: uid() }));
      update((s) => {
        s.transactions = [...s.transactions, ...txs];
        for (const t of txs.filter((x) => x.recurring && x.direction === "out"))
          if (!s.obligations.some((o) => o.title.toLowerCase() === String(t.merchant).toLowerCase()))
            s.obligations.push({
              id: uid(), title: t.merchant, amount: Math.abs(t.amount), due: addMonths(t.date, 1),
              category: t.category, recurring: true, snoozes: 0, done: false });
        return s;
      });
      setRaw("");
    } catch {
      setErr("Couldn't read that. Try fewer rows, or paste one transaction per line.");
    }
    setBusy(false);
  }

  const allCats = [...state.categories, ...state.incomeCategories];

  return (
    <div className="divide-y divide-slate-800">
      <section className="px-5 py-6">
        <div className={`text-3xl font-semibold ${net < 0 ? "text-rose-300" : ""}`}>
          {net < 0 ? "−" : ""}{fmt(Math.abs(net))}
        </div>
        <div className="text-sm text-slate-400 mt-1">
          {net < 0 ? "more out than in" : "left over"}
        </div>
        <div className="flex gap-6 mt-4 text-sm">
          <span className="flex items-center gap-1.5">
            <ArrowDownLeft className="w-4 h-4 text-emerald-400" />{fmt(inTotal)}
          </span>
          <span className="flex items-center gap-1.5">
            <ArrowUpRight className="w-4 h-4 text-rose-400" />{fmt(outTotal)}
          </span>
        </div>
        {byCat.length > 0 && (
          <ul className="mt-5 space-y-3">
            {byCat.map(([c, v]) => (
              <li key={c}>
                <div className="flex justify-between text-sm mb-1.5">
                  <span>{c}</span><span className="text-slate-300">{fmt(v)}</span>
                </div>
                <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-sky-400" style={{ width: `${(v / outTotal) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-5 py-6">
        <h2 className="text-sm font-medium mb-3">Add money in or out</h2>
        <div className="flex gap-2 mb-3">
          {[["out", "Spent"], ["in", "Received"]].map(([v, l]) => (
            <button key={v} onClick={() => setDraft({ ...draft, direction: v,
                category: v === "in" ? state.incomeCategories[0] : state.categories[0] })}
              className={`flex-1 py-2 rounded-lg text-sm border ${
                draft.direction === v ? "bg-slate-100 text-slate-900 border-slate-100" : "border-slate-700 text-slate-300"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mb-3">
          <input className={inputCls} placeholder="Where / who" value={draft.merchant}
            onChange={(e) => setDraft({ ...draft, merchant: e.target.value })} />
          <input className={`${inputCls} w-28`} type="number" inputMode="decimal" placeholder="0.00"
            value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
        </div>
        <div className="flex gap-2 mb-3">
          <select className={inputCls} value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
            {(draft.direction === "in" ? state.incomeCategories : state.categories)
              .map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className={inputCls} type="date" value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        </div>
        <button onClick={addManual}
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-900">
          <Plus className="w-4 h-4" /> Add
        </button>
      </section>

      <section className="px-5 py-6">
        <h2 className="text-sm font-medium mb-1">Read a statement</h2>
        <p className="text-xs text-slate-400 mb-3">
          Paste rows from your bank or card. Deposits and purchases both get picked up; recurring charges become tracked bills.
        </p>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={4} className={inputCls}
          placeholder={"03/14  NETFLIX.COM  -22.99\n03/15  DIRECT DEP PAYROLL  +2140.00"} />
        {err && <p className="text-xs text-rose-400 mt-2">{err}</p>}
        <button onClick={readStatement} disabled={busy || !raw.trim()}
          className="mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-900 disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {busy ? "Reading" : "Read statement"}
        </button>
      </section>

      <section className="px-5 py-6">
        <h2 className="text-sm font-medium mb-3">Categories</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {allCats.map((c) => (
            <span key={c} className="flex items-center gap-1.5 text-xs bg-slate-800 rounded-md px-2 py-1">
              {c}
              <button onClick={() => update((s) => {
                s.categories = s.categories.filter((x) => x !== c);
                s.incomeCategories = s.incomeCategories.filter((x) => x !== c);
                return s; })}>
                <X className="w-3 h-3 text-slate-500" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="Add a category" value={newCat}
            onChange={(e) => setNewCat(e.target.value)} />
          <button onClick={() => {
              if (newCat.trim()) update((s) => { s.categories = [...s.categories, newCat.trim()]; return s; });
              setNewCat(""); }}
            className="px-3 rounded-lg border border-slate-700 text-sm shrink-0">Add</button>
        </div>
      </section>

      {state.transactions.length > 0 && (
        <section className="px-5 py-6">
          <h2 className="text-sm font-medium mb-3">Transactions</h2>
          <ul className="space-y-1">
            {state.transactions.slice().reverse().slice(0, 40).map((t) => (
              <li key={t.id}>
                <button onClick={() => setEditTx(t)}
                  className="w-full flex justify-between items-center py-1.5 text-sm text-left">
                  <span className="min-w-0 truncate">
                    {t.merchant}
                    <span className="text-slate-500 text-xs ml-2">{t.category} · {t.date}</span>
                  </span>
                  <span className={`shrink-0 ml-3 ${t.direction === "in" ? "text-emerald-400" : ""}`}>
                    {t.direction === "in" ? "+" : "−"}{fmt(Math.abs(t.amount))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editTx && (
        <EditTransaction tx={editTx} state={state} onClose={() => setEditTx(null)}
          onSave={(n) => { update((s) => {
            s.transactions = s.transactions.map((x) => x.id === n.id ? n : x); return s; }); setEditTx(null); }}
          onDelete={(id) => { update((s) => {
            s.transactions = s.transactions.filter((x) => x.id !== id); return s; }); setEditTx(null); }} />
      )}
    </div>
  );
}

function EditTransaction({ tx, state, onSave, onDelete, onClose }) {
  const [d, setD] = useState({ ...tx, amount: Math.abs(tx.amount) });
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const cats = d.direction === "in" ? state.incomeCategories : state.categories;

  return (
    <Sheet title="Edit transaction" onClose={onClose}>
      <div className="flex gap-2 mb-4">
        {[["out", "Spent"], ["in", "Received"]].map(([v, l]) => (
          <button key={v} onClick={() => setD({ ...d, direction: v,
              category: v === "in" ? state.incomeCategories[0] : state.categories[0] })}
            className={`flex-1 py-2 rounded-lg text-sm border ${
              d.direction === v ? "bg-slate-100 text-slate-900 border-slate-100" : "border-slate-700 text-slate-300"}`}>
            {l}
          </button>
        ))}
      </div>
      <Field label="Where / who">
        <input className={inputCls} value={d.merchant} onChange={(e) => set("merchant", e.target.value)} />
      </Field>
      <Field label="Amount">
        <input className={inputCls} type="number" inputMode="decimal" value={d.amount}
          onChange={(e) => set("amount", e.target.value)} />
      </Field>
      <Field label="Category">
        <select className={inputCls} value={d.category} onChange={(e) => set("category", e.target.value)}>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Date">
        <input className={inputCls} type="date" value={d.date} onChange={(e) => set("date", e.target.value)} />
      </Field>
      <div className="flex gap-2 mt-6">
        <button onClick={() => onSave({ ...d, amount: Number(d.amount) })}
          className="flex-1 py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium">Save changes</button>
        <button onClick={() => onDelete(d.id)}
          className="px-4 rounded-lg border border-slate-700 text-slate-400"><Trash2 className="w-4 h-4" /></button>
      </div>
    </Sheet>
  );
}

/* ================= notes ================= */

function NotesView({ state, update }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState({});
  const [filter, setFilter] = useState("All");

  const noteCats = useMemo(() => {
    const set = new Set(state.notes.map((n) => n.category).filter(Boolean));
    return ["All", ...set];
  }, [state.notes]);

  async function addNote() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);

    if (looksSensitive(body)) {
      // Never leaves the device.
      update((s) => {
        s.notes.unshift({
          id: uid(), created: iso(), text: body, masked: maskSecrets(body),
          category: "Passwords", tags: [guessService(body)], sensitive: true });
        return s;
      });
      setText(""); setBusy(false);
      return;
    }

    try {
      const out = await callClaude(
        [{ role: "user", content: body }],
        `Today is ${iso()}. File this note.
category: one or two words describing what kind of note it is (e.g. Ideas, Health, Car, Work, Recipes, Travel).
tags: up to 4 short searchable keywords.
summary: under 10 words, only if the note is long; otherwise null.
reminder: if the note implies something the person has to DO by a date, return {"title":"","due":"YYYY-MM-DD","amount":null}. Otherwise null. Don't invent deadlines.
Return ONLY JSON:
{"category":"","tags":[],"summary":null,"reminder":null}`
      );
      const r = parseJSON(out);
      update((s) => {
        s.notes.unshift({ id: uid(), created: iso(), text: body,
          category: r.category || "Notes", tags: r.tags || [], summary: r.summary, sensitive: false });
        if (r.reminder?.title)
          s.obligations.push({ id: uid(), title: r.reminder.title, due: r.reminder.due,
            amount: r.reminder.amount ?? null, category: "Other",
            recurring: false, snoozes: 0, done: false, fromNote: true });
        return s;
      });
      setText("");
    } catch {
      update((s) => {
        s.notes.unshift({ id: uid(), created: iso(), text: body, category: "Notes", tags: [], sensitive: false });
        return s;
      });
      setText("");
    }
    setBusy(false);
  }

  const shown = state.notes.filter((n) => filter === "All" || n.category === filter);

  return (
    <div className="divide-y divide-slate-800">
      <section className="px-5 py-6">
        <textarea className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Write anything. It gets filed on its own." />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={addNote} disabled={busy || !text.trim()}
            className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-900 disabled:opacity-40">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Save note
          </button>
          {looksSensitive(text) && text.trim() && (
            <span className="flex items-center gap-1.5 text-xs text-amber-300">
              <Lock className="w-3.5 h-3.5" /> Stays on this device
            </span>
          )}
        </div>
      </section>

      <section className="px-5 py-4">
        <div className="flex items-start gap-2.5 text-xs text-slate-400">
          <Shield className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
          <p>
            Notes with passwords, keys or account numbers are detected on your device, filed under
            Passwords, and never sent to the AI. They're stored unencrypted though — treat this as a
            scratchpad, not a vault.
          </p>
        </div>
      </section>

      {noteCats.length > 1 && (
        <section className="px-5 py-3">
          <div className="flex gap-2 flex-wrap">
            {noteCats.map((c) => (
              <button key={c} onClick={() => setFilter(c)}
                className={`text-xs px-2.5 py-1 rounded-md border ${
                  filter === c ? "bg-slate-100 text-slate-900 border-slate-100" : "border-slate-700 text-slate-400"}`}>
                {c}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="px-5 py-4">
        {shown.length === 0 ? (
          <p className="text-sm text-slate-500 py-8 text-center">No notes here yet.</p>
        ) : (
          <ul className="space-y-3">
            {shown.map((n) => (
              <li key={n.id} className="bg-slate-800 rounded-lg p-3.5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <span className="flex items-center gap-1.5 text-xs text-slate-400">
                    {n.sensitive && <Lock className="w-3 h-3 text-amber-400" />}
                    {n.category}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    {n.sensitive && (
                      <button onClick={() => setRevealed((r) => ({ ...r, [n.id]: !r[n.id] }))}>
                        {revealed[n.id]
                          ? <EyeOff className="w-3.5 h-3.5 text-slate-500" />
                          : <Eye className="w-3.5 h-3.5 text-slate-500" />}
                      </button>
                    )}
                    <button onClick={() => update((s) => {
                      s.notes = s.notes.filter((x) => x.id !== n.id); return s; })}>
                      <Trash2 className="w-3.5 h-3.5 text-slate-600" />
                    </button>
                  </div>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words">
                  {n.sensitive && !revealed[n.id] ? n.masked : n.text}
                </p>
                {n.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {n.tags.map((t) => (
                      <span key={t} className="text-xs text-slate-500">#{t}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ================= rules ================= */

function RulesView({ state, update }) {
  const [when, setWhen] = useState(WHEN_OPTIONS[0].id);
  const [value, setValue] = useState(WHEN_OPTIONS[0].def);
  const [then, setThen] = useState(THEN_OPTIONS[0].id);
  const opt = WHEN_OPTIONS.find((w) => w.id === when);

  return (
    <div className="divide-y divide-slate-800">
      <section className="px-5 py-6">
        <h2 className="text-sm font-medium mb-1">Build an automation</h2>
        <p className="text-xs text-slate-400 mb-4">Pick a trigger and what should happen. No code.</p>

        <Field label="When">
          <select className={inputCls} value={when}
            onChange={(e) => { setWhen(e.target.value); setValue(WHEN_OPTIONS.find((w) => w.id === e.target.value).def); }}>
            {WHEN_OPTIONS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-2 mb-3">
          <input type="number" className={`${inputCls} w-24`} value={value} onChange={(e) => setValue(e.target.value)} />
          <span className="text-sm text-slate-400">{opt.unit}</span>
        </div>
        <Field label="Then">
          <select className={inputCls} value={then} onChange={(e) => setThen(e.target.value)}>
            {THEN_OPTIONS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
        <button onClick={() => update((s) => {
            s.rules = [...s.rules, { id: uid(), when, value: Number(value), then }]; return s; })}
          className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg bg-slate-100 text-slate-900">
          <Plus className="w-4 h-4" /> Save automation
        </button>
      </section>

      <section className="px-5 py-6">
        <h2 className="text-sm font-medium mb-3">Your automations</h2>
        {state.rules.length === 0 ? (
          <p className="text-sm text-slate-500">
            None yet. The one most people want first: nudge me 3 days before a bill is due.
          </p>
        ) : (
          <ul className="space-y-3">
            {state.rules.map((r) => {
              const w = WHEN_OPTIONS.find((x) => x.id === r.when);
              const t = THEN_OPTIONS.find((x) => x.id === r.then);
              return (
                <li key={r.id} className="flex gap-3 bg-slate-800 rounded-lg p-3">
                  <Zap className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="flex-1 text-sm">
                    <div>When {w.label.replace("__", r.value)}</div>
                    <div className="text-slate-400 text-xs mt-0.5">then {t.label}</div>
                  </div>
                  <button onClick={() => update((s) => { s.rules = s.rules.filter((x) => x.id !== r.id); return s; })}>
                    <X className="w-4 h-4 text-slate-500" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ================= add bar ================= */

function AddBar({ state, update, openAgent }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const voice = useVoice((t) => { setText(t); submit(t); });

  async function submit(override) {
    const input = (override ?? text).trim();
    if (!input || busy) return;
    setBusy(true);
    try {
      const out = await callClaude([{ role: "user", content: input }],
        `Today is ${iso()}. Decide what the user just said.

If it's money that already moved ("spent 40 at kroger", "got paid 2100"), return:
{"kind":"transaction","merchant":"","amount":0,"direction":"out","date":"YYYY-MM-DD","category":""}

If it's something owed or to be done later, return:
{"kind":"obligation","title":"","amount":null,"due":"YYYY-MM-DD","category":"","recurring":false}

Expense categories: ${state.categories.join(", ")}
Income categories: ${state.incomeCategories.join(", ")}
Resolve relative dates to absolute ones. amount is null when no money is involved.
Return ONLY JSON.`);
      const r = parseJSON(out);
      update((s) => {
        if (r.kind === "transaction")
          s.transactions.push({ ...r, id: uid(), amount: Math.abs(Number(r.amount)), recurring: false });
        else
          s.obligations.push({ ...r, id: uid(), snoozes: 0, done: false });
        return s;
      });
      setText("");
    } catch {
      update((s) => {
        s.obligations.push({ id: uid(), title: input, amount: null, due: null,
          category: "Other", recurring: false, snoozes: 0, done: false });
        return s;
      });
      setText("");
    }
    setBusy(false);
  }

  return (
    <div className="fixed bottom-14 inset-x-0 px-4 py-3 bg-slate-900 border-t border-slate-800">
      <div className="flex items-center gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={voice.listening ? "Listening…" : "Add a bill, task or spend"}
          className="flex-1 bg-slate-800 rounded-full px-4 py-2.5 text-sm placeholder-slate-500 outline-none" />
        {voice.supported && (
          <button onClick={voice.listening ? voice.stop : voice.start}
            className={`p-2.5 rounded-full ${voice.listening ? "bg-rose-500" : "bg-slate-800"}`}>
            <Mic className="w-4 h-4" />
          </button>
        )}
        <button onClick={() => submit()} disabled={busy}
          className="p-2.5 rounded-full bg-slate-100 text-slate-900 disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        </button>
        <button onClick={() => openAgent({ seed: "" })} className="p-2.5 rounded-full bg-slate-800">
          <MessageSquare className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/* ================= agent ================= */

function AgentSheet({ seed, state, update, onClose }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const endRef = useRef(null);

  const context = () => {
    const spend = {}, income = {};
    for (const t of state.transactions) {
      const m = t.direction === "in" ? income : spend;
      m[t.category] = Number(((m[t.category] || 0) + Math.abs(t.amount)).toFixed(2));
    }
    return JSON.stringify({
      obligations: state.obligations.map((o) => ({
        id: o.id, title: o.title, amount: o.amount, due: o.due,
        category: o.category, recurring: o.recurring, snoozes: o.snoozes, done: o.done })),
      spendByCategory: spend, incomeByCategory: income,
      // sensitive notes are withheld on purpose
      notes: state.notes.filter((n) => !n.sensitive).map((n) => ({ category: n.category, text: n.text.slice(0, 200) })),
    });
  };

  const SYSTEM = `You help someone stay on top of bills, tasks and money. Today is ${iso()}.

Their ledger: ${context()}

Be brief and concrete — this is a phone screen. Ask one question at a time.

If the picture is incomplete, ask for what's missing rather than guessing: an income figure, a category for an unclassified spend, whether a charge is recurring.

When something has been snoozed repeatedly, don't nag. Repeated snoozing usually means the task is too big, blocked on something else, or scheduled at an impossible time. Find out which, then propose one specific fix: split it into a smaller first step, move it to a realistic slot, draft the message that unblocks it, or drop it. Dropping it is a legitimate outcome.

You can change the ledger. Return ONLY JSON, no markdown:
{"reply":"what you say","actions":[]}

Actions:
{"op":"add","title":"","amount":null,"due":"YYYY-MM-DD","category":"","recurring":false}
{"op":"complete","id":""}
{"op":"reschedule","id":"","due":"YYYY-MM-DD"}
{"op":"edit","id":"","title":"","amount":null,"due":"YYYY-MM-DD","category":""}
{"op":"delete","id":""}
{"op":"spend","merchant":"","amount":0,"direction":"out","date":"YYYY-MM-DD","category":""}
Empty actions array when you're only talking.`;

  async function send(override) {
    const content = (override ?? input).trim();
    if (!content || busy) return;
    const next = [...msgs, { role: "user", content }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const { reply, actions = [] } = parseJSON(await callClaude(next, SYSTEM));
      if (actions.length)
        update((s) => {
          for (const a of actions) {
            if (a.op === "add") s.obligations.push({ ...a, id: uid(), snoozes: 0, done: false });
            if (a.op === "spend")
              s.transactions.push({ ...a, id: uid(), amount: Math.abs(Number(a.amount)), recurring: false });
            if (a.op === "complete")
              s.obligations = s.obligations.map((o) => o.id === a.id ? { ...o, done: true } : o);
            if (a.op === "reschedule")
              s.obligations = s.obligations.map((o) => o.id === a.id ? { ...o, due: a.due, snoozes: 0 } : o);
            if (a.op === "edit")
              s.obligations = s.obligations.map((o) => o.id === a.id
                ? { ...o, ...Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== "op" && k !== "id" && v != null)) }
                : o);
            if (a.op === "delete") s.obligations = s.obligations.filter((o) => o.id !== a.id);
          }
          return s;
        });
      setMsgs([...next, { role: "assistant", content: reply, changed: actions.length }]);
    } catch {
      setMsgs([...next, { role: "assistant", content: "That didn't go through. Try again?" }]);
    }
    setBusy(false);
  }

  useEffect(() => { if (!started.current && seed.seed) { started.current = true; send(seed.seed); } }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  return (
    <div className="fixed inset-0 bg-slate-900 flex flex-col z-30">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
        <span className="text-sm font-medium">Agent</span>
        <button onClick={onClose}><X className="w-5 h-5 text-slate-400" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {msgs.length === 0 && !busy && (
          <p className="text-sm text-slate-500">
            Ask what's coming up, log a spend, or work through anything you keep putting off.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block text-sm rounded-2xl px-3.5 py-2.5 max-w-[85%] text-left ${
              m.role === "user" ? "bg-slate-100 text-slate-900" : "bg-slate-800"}`}>
              {m.content}
            </div>
            {m.changed > 0 && (
              <div className="text-xs text-emerald-400 mt-1.5">
                Updated your ledger ({m.changed} change{m.changed === 1 ? "" : "s"})
              </div>
            )}
          </div>
        ))}
        {busy && <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />}
        <div ref={endRef} />
      </div>
      <div className="px-4 py-3 border-t border-slate-800 flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Say something"
          className="flex-1 bg-slate-800 rounded-full px-4 py-2.5 text-sm placeholder-slate-500 outline-none" />
        <button onClick={() => send()} disabled={busy}
          className="p-2.5 rounded-full bg-slate-100 text-slate-900 disabled:opacity-40">
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/* ================= mount ================= */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
