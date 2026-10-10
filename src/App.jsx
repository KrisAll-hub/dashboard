import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

/* ============================================================
   CONFIGURATION
   ============================================================ */

// Lien de publication du Google Sheet (Fichier > Partager > Publier sur le web)
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQpQdMuKrJJuoKeS21rgxYPv7jFg9HIYF3W0MqjF9BFZ7oAYKQvs2J2cFra0fXETA/pub?output=csv";

// Identifiants (gid) des onglets du Sheet publié.
// Visibles dans l'URL de l'onglet : ...#gid=XXXXXXXX
const SHEET_GIDS = {
  week: "1653386731", // 📊 Hebdomadaire
  month: "719176496", // 📊 Mensuel
};

// Clé API Anthropic. Laisser vide si l'app tourne dans un environnement
// qui injecte l'authentification (ex : artefact claude.ai).
// ⚠️ Ne jamais publier une vraie clé dans du code front-end public.
const ANTHROPIC_API_KEY = "";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

const COLORS = {
  bg: "#07090F",
  card: "#090d29",
  cardHover: "#0d1238",
  accent: "#C8F464",
  text: "#EEF1FA",
  muted: "#7C84A6",
  border: "rgba(200, 244, 100, 0.10)",
  borderSoft: "rgba(255, 255, 255, 0.06)",
  red: "#FF6B7A",
  amber: "#F4C464",
};

// Onglets + KPIs attendus. Chaque KPI est mappé sur la ligne du Sheet
// qui porte le même nom (insensible aux accents/majuscules) ; à défaut,
// on prend la ligne suivante disponible dans la section.
// inverse: true → une baisse est une bonne nouvelle.
const TABS = [
  {
    id: "ventes",
    label: "Ventes",
    icon: "💰",
    kpis: [
      { name: "Chiffre d'affaires", icon: "💶" },
      { name: "Commandes", icon: "📦" },
      { name: "Panier moyen", icon: "🛒" },
      { name: "Taux d'abandon", icon: "🚪", inverse: true },
      { name: "Nouveaux clients", icon: "👤" },
      { name: "Note moyenne", icon: "⭐" },
    ],
  },
  {
    id: "pub",
    label: "Pub",
    icon: "📣",
    kpis: [
      { name: "Dépenses pub", icon: "💸", neutral: true },
      { name: "ROAS", icon: "📈" },
      { name: "CPA", icon: "🎯", inverse: true },
      { name: "Impressions", icon: "👁️" },
      { name: "CTR", icon: "🖱️" },
      { name: "Clics", icon: "👆" },
    ],
  },
  {
    id: "reseaux",
    label: "Réseaux",
    icon: "📱",
    kpis: [
      { name: "Abonnés", icon: "👥" },
      { name: "Taux engagement", icon: "💬" },
      { name: "Posts publiés", icon: "📝" },
      { name: "Portée organique", icon: "📡" },
      { name: "Partages", icon: "🔄" },
      { name: "Messages reçus", icon: "💌" },
    ],
  },
  {
    id: "emails",
    label: "Emails",
    icon: "📧",
    kpis: [
      { name: "Campagnes envoyées", icon: "📨" },
      { name: "Taux ouverture", icon: "📬" },
      { name: "Taux de clic", icon: "🖱️" },
      { name: "Liste abonnés", icon: "📋" },
      { name: "Désabonnements", icon: "📉", inverse: true },
      { name: "Revenus email", icon: "💰" },
    ],
  },
  {
    id: "lancements",
    label: "Lancements",
    icon: "🚀",
    kpis: [
      { name: "Lancements", icon: "🎉" },
      { name: "Pré-inscriptions", icon: "✍️" },
      { name: "Revenu lancement", icon: "💎" },
      { name: "Taux conversion", icon: "🏆" },
      { name: "Score satisfaction", icon: "😊" },
      { name: "Remboursements", icon: "↩️", inverse: true },
    ],
  },
];

const AI_TAB = { id: "ia", label: "IA", icon: "🤖" };
const ALL_TABS = [...TABS, AI_TAB];
const SECTION_KEYS = TABS.map((t) => t.id);

/* ============================================================
   UTILITAIRES — parsing du Google Sheet
   ============================================================ */

const sheetBase = () => SHEET_URL.split(/\/pub(html)?/)[0];
const csvUrl = (gid) => `${sheetBase()}/pub?gid=${gid}&single=true&output=csv`;

// Normalise un libellé : sans accents, sans emoji, minuscules, alphanumérique
const norm = (s = "") =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Parseur CSV (gère les guillemets, virgules et retours à la ligne dans les cellules)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

// "15,200" → 15200 · "43.2" → 43.2 · "43,2" → 43.2 · "—" → null
function parseNum(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s  €%x$]/gi, "").replace("/5", "");
  if (!s || s === "—" || s === "-") return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Découpe un onglet (Hebdomadaire / Mensuel) en sections par catégorie.
// Format attendu par section :
//   ,💰 Ventes
//   ,KPI,Unité,<période 1>,...,<période n>,Tendance
//   <icône>,<nom KPI>,<unité>,<valeur 1>,...,<valeur n>,<tendance>
function parseSheet(rows) {
  const title = (rows[0] || []).find(Boolean) || "";
  const subtitle = (rows[1] || []).find(Boolean) || "";
  const sections = {};
  let current = null;

  for (const r of rows) {
    const c0 = r[0] || "";
    const c1 = r[1] || "";
    const restEmpty = r.slice(2).every((x) => !x);
    const key = norm(c1);

    // Titre de section : "💰 Ventes" seul sur la ligne
    if (!c0 && restEmpty && SECTION_KEYS.includes(key)) {
      current = { periods: [], rows: [] };
      sections[key] = current;
      continue;
    }
    if (!current) continue;

    // Ligne d'en-tête "KPI, Unité, périodes..., Tendance"
    if (key === "kpi") {
      const end = r.findIndex((x, i) => i > 2 && norm(x).startsWith("tendance"));
      current.periods = r.slice(3, end > 0 ? end : undefined).filter(Boolean);
      continue;
    }

    // Ligne vide → fin de section
    if (!c1) {
      if (current.rows.length) current = null;
      continue;
    }

    if (current.periods.length) {
      current.rows.push({
        icon: c0,
        name: c1,
        unit: r[2] || "",
        values: current.periods.map((_, i) => parseNum(r[3 + i])),
      });
    }
  }
  return { title, subtitle, sections };
}

// Associe les lignes du Sheet aux 6 KPIs attendus de chaque onglet
function mapSheetToTabs(parsed) {
  const tabs = {};
  let periods = [];
  for (const tab of TABS) {
    const section = parsed.sections[tab.id] || { periods: [], rows: [] };
    if (section.periods.length > periods.length) periods = section.periods;
    const used = new Set();
    const matched = tab.kpis.map((cfg) => {
      const i = section.rows.findIndex((r, j) => !used.has(j) && norm(r.name) === norm(cfg.name));
      if (i >= 0) used.add(i);
      return i;
    });
    tabs[tab.id] = tab.kpis.map((cfg, k) => {
      let i = matched[k];
      if (i < 0) {
        i = section.rows.findIndex((_, j) => !used.has(j));
        if (i >= 0) used.add(i);
      }
      const row = section.rows[i];
      return {
        ...cfg,
        name: row?.name || cfg.name,
        icon: row?.icon || cfg.icon,
        unit: row?.unit || "",
        values: row?.values || [],
      };
    });
  }
  return { periods, tabs };
}

function extractClient(dashboardRows, weekParsed) {
  // Tableau de bord : ligne 2 = "Maison Soleil — Boutique e-commerce"
  const line = (dashboardRows?.[1] || []).find(Boolean);
  if (line) {
    const [name, ...rest] = line.split(/\s+[—–-]\s+/);
    return { name: name.trim(), activity: rest.join(" — ").trim() };
  }
  // Repli : "FlowBoard — Maison Soleil — Vue Hebdomadaire"
  const parts = (weekParsed?.title || "").split(/\s+[—–-]\s+/);
  return { name: parts[1] || "Client", activity: "" };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("Le Sheet n'est pas publié en CSV");
  return text;
}

async function loadSheetData() {
  const [dashboardText, weekText, monthText] = await Promise.all([
    fetchText(SHEET_URL).catch(() => ""), // onglet synthèse : optionnel
    fetchText(csvUrl(SHEET_GIDS.week)),
    fetchText(csvUrl(SHEET_GIDS.month)),
  ]);
  const weekParsed = parseSheet(parseCSV(weekText));
  const monthParsed = parseSheet(parseCSV(monthText));
  if (!Object.keys(weekParsed.sections).length && !Object.keys(monthParsed.sections).length) {
    throw new Error("Aucune section (Ventes, Pub, Réseaux, Emails, Lancements) trouvée dans le Sheet");
  }
  return {
    client: extractClient(dashboardText ? parseCSV(dashboardText) : null, weekParsed),
    week: mapSheetToTabs(weekParsed),
    month: mapSheetToTabs(monthParsed),
  };
}

/* ============================================================
   UTILITAIRES — calculs & formatage
   ============================================================ */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function trendAt(values, i) {
  const cur = values[i];
  const prev = values[i - 1];
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function formatValue(v, unit, compact = false) {
  if (v == null) return "—";
  const abs = Math.abs(v);
  let num;
  if (compact && abs >= 100000) {
    num = `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v / 1000)} k`;
  } else {
    const decimals = Number.isInteger(v) ? 0 : 1;
    num = new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(v);
  }
  switch (unit) {
    case "€":
      return `${num} €`;
    case "%":
      return `${num} %`;
    case "x":
      return `${num}x`;
    case "/5":
      return `${num}/5`;
    default:
      return unit ? `${num} ${unit}` : num;
  }
}

// Graduations de l'axe Y : 15200 → "15,2k"
const formatAxis = (v) =>
  Math.abs(v) >= 1000
    ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v / 1000)}k`
    : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v);

const formatTrend = (t) =>
  t == null ? "—" : `${t > 0 ? "+" : ""}${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(t)} %`;

// Score de santé 0-100 : moyenne des tendances de tous les KPIs sur la période
// (+10 % ≈ 70 pts, stable = 50 pts, -10 % ≈ 30 pts ; KPIs « inversés » pris en compte)
function computeHealth(periodData, idx) {
  if (!periodData) return null;
  const scores = [];
  for (const tab of TABS) {
    for (const kpi of periodData.tabs[tab.id] || []) {
      if (kpi.neutral) continue;
      const t = trendAt(kpi.values, idx);
      if (t == null) continue;
      const signed = kpi.inverse ? -t : t;
      scores.push(clamp(50 + clamp(signed, -25, 25) * 2, 0, 100));
    }
  }
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

const healthColor = (s) => (s == null ? COLORS.muted : s >= 65 ? COLORS.accent : s >= 45 ? COLORS.amber : COLORS.red);
const healthLabel = (s) =>
  s == null ? "N/A" : s >= 80 ? "Excellent" : s >= 65 ? "Bonne forme" : s >= 45 ? "À surveiller" : "Critique";

function useIsDesktop() {
  const query = "(min-width: 900px)";
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsDesktop(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

/* ============================================================
   COMPOSANTS
   ============================================================ */

function HealthRing({ score }) {
  const size = 58;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = score == null ? 0 : score / 100;
  const color = healthColor(score);
  return (
    <div className="fb-health" title={`Score de santé : ${healthLabel(score)}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset .6s ease, stroke .3s" }}
        />
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fill={color} fontSize="17" fontWeight="700">
          {score ?? "–"}
        </text>
      </svg>
      <div className="fb-health-label">
        <span>Santé</span>
        <strong style={{ color }}>{healthLabel(score)}</strong>
      </div>
    </div>
  );
}

function KpiCard({ kpi, idx, active, onClick }) {
  const value = kpi.values[idx];
  const t = trendAt(kpi.values, idx);
  const good = t == null || kpi.neutral ? null : kpi.inverse ? t < 0 : t > 0;
  const trendColor = t == null || t === 0 || good == null ? COLORS.muted : good ? COLORS.accent : COLORS.red;
  const arrow = t == null || t === 0 ? "→" : t > 0 ? "↑" : "↓";
  return (
    <button className={`fb-card ${active ? "is-active" : ""}`} onClick={onClick}>
      <div className="fb-card-top">
        <span className="fb-card-icon">{kpi.icon}</span>
        <span className="fb-trend" style={{ color: trendColor, background: `${trendColor}14` }}>
          {arrow} {formatTrend(t)}
        </span>
      </div>
      <div className="fb-card-value">{formatValue(value, kpi.unit, true)}</div>
      <div className="fb-card-name">{kpi.name}</div>
    </button>
  );
}

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="fb-tooltip">
      <div className="fb-tooltip-label">{label}</div>
      <div className="fb-tooltip-value">{formatValue(payload[0].value, unit)}</div>
    </div>
  );
}

function KpiChart({ kpi, periods, idx, isDesktop }) {
  const data = periods.map((p, i) => ({ period: p, value: kpi.values[i] ?? null }));
  const gradientId = `fb-grad-${norm(kpi.name)}`;
  return (
    <section className="fb-chart">
      <div className="fb-chart-head">
        <div>
          <div className="fb-chart-title">
            {kpi.icon} {kpi.name}
          </div>
          <div className="fb-chart-sub">Évolution sur {periods.length} périodes · cliquez une carte pour changer</div>
        </div>
        <div className="fb-chart-current">{formatValue(kpi.values[idx], kpi.unit)}</div>
      </div>
      <div style={{ width: "100%", height: isDesktop ? 340 : 220 }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 10, right: 18, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis
              dataKey="period"
              tick={{ fill: COLORS.muted, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fill: COLORS.muted, fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={isDesktop ? 56 : 40}
              tickFormatter={formatAxis}
            />
            <Tooltip content={<ChartTooltip unit={kpi.unit} />} cursor={{ stroke: COLORS.accent, strokeOpacity: 0.3 }} />
            {periods[idx] && (
              <ReferenceLine x={periods[idx]} stroke={COLORS.accent} strokeDasharray="4 4" strokeOpacity={0.6} />
            )}
            <Area
              type="monotone"
              dataKey="value"
              stroke={COLORS.accent}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
              dot={{ r: 3, fill: COLORS.bg, stroke: COLORS.accent, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: COLORS.accent, stroke: COLORS.bg, strokeWidth: 2 }}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// Rendu minimal du markdown renvoyé par Claude (titres, listes, gras)
function RichText({ text }) {
  const inline = (s, key) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>
      ) : (
        <React.Fragment key={`${key}-${i}`}>{part}</React.Fragment>
      )
    );
  return (
    <div className="fb-rich">
      {text.split("\n").map((line, i) => {
        const l = line.trim();
        if (!l) return <div key={i} style={{ height: 8 }} />;
        if (/^#{1,4}\s/.test(l)) return <h4 key={i}>{inline(l.replace(/^#{1,4}\s/, ""), i)}</h4>;
        if (/^[-*•]\s/.test(l)) return <div key={i} className="fb-li">{inline(l.replace(/^[-*•]\s/, ""), i)}</div>;
        if (/^\d+[.)]\s/.test(l)) return <div key={i} className="fb-li fb-li-num">{inline(l, i)}</div>;
        return <p key={i}>{inline(l, i)}</p>;
      })}
    </div>
  );
}

function AiPanel({ data, mode, idx, client, health }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const periodData = data[mode];
  const periodLabel = periodData.periods[idx];
  const prevLabel = periodData.periods[idx - 1];

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    const lines = TABS.map((tab) => {
      const kpis = periodData.tabs[tab.id]
        .map((k) => {
          const t = trendAt(k.values, idx);
          return `  - ${k.name} : ${formatValue(k.values[idx], k.unit)} (précédent : ${formatValue(
            k.values[idx - 1],
            k.unit
          )}, tendance : ${formatTrend(t)}${k.inverse ? ", plus bas = mieux" : ""})`;
        })
        .join("\n");
      return `${tab.icon} ${tab.label}\n${kpis}`;
    }).join("\n\n");

    const prompt = `Tu es une experte en marketing digital qui conseille une assistante virtuelle (VA) sur les résultats de sa cliente.

Client : ${client.name}${client.activity ? ` (${client.activity})` : ""}
Vue : ${mode === "week" ? "hebdomadaire" : "mensuelle"} — période ${periodLabel}${prevLabel ? ` comparée à ${prevLabel}` : ""}
Score de santé global : ${health ?? "N/A"}/100

KPIs :
${lines}

Rédige une analyse en français, concise et actionnable, au format markdown :
## Synthèse
(2-3 phrases)
## Points forts
(3 puces maximum, chiffres à l'appui)
## Points de vigilance
(3 puces maximum, chiffres à l'appui)
## Actions recommandées cette ${mode === "week" ? "semaine" : "période"}
(3 actions concrètes et priorisées que la VA peut mettre en place)`;

    try {
      const headers = { "Content-Type": "application/json" };
      if (ANTHROPIC_API_KEY) {
        headers["x-api-key"] = ANTHROPIC_API_KEY;
        headers["anthropic-version"] = "2023-06-01";
        headers["anthropic-dangerous-direct-browser-access"] = "true";
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1200,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message || `Erreur HTTP ${res.status}`);
      const text = (json?.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (!text) throw new Error("Réponse vide de l'API");
      setResult({ text, label: periodLabel, mode });
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="fb-ai">
      <div className="fb-ai-head">
        <div>
          <div className="fb-chart-title">🤖 Analyse IA</div>
          <div className="fb-chart-sub">
            Claude analyse les 30 KPIs de la période <strong>{periodLabel}</strong> et propose un plan d'action.
          </div>
        </div>
        <button className="fb-btn" onClick={analyze} disabled={loading}>
          {loading ? (
            <>
              <span className="fb-spinner fb-spinner-sm" /> Analyse…
            </>
          ) : (
            "✨ Analyser"
          )}
        </button>
      </div>

      {error && (
        <div className="fb-alert">
          <strong>L'analyse a échoué.</strong> {error}
          {!ANTHROPIC_API_KEY && (
            <div className="fb-alert-hint">
              Hors de claude.ai, renseignez <code>ANTHROPIC_API_KEY</code> en haut du fichier App.jsx.
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="fb-ai-skeleton">
          {[90, 75, 82, 60].map((w, i) => (
            <div key={i} className="fb-skel" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}

      {result && !loading && (
        <div className="fb-ai-result">
          <div className="fb-ai-meta">
            Analyse {result.mode === "week" ? "hebdomadaire" : "mensuelle"} · {result.label}
          </div>
          <RichText text={result.text} />
        </div>
      )}

      {!result && !loading && !error && (
        <div className="fb-ai-empty">Cliquez sur « Analyser » pour générer un diagnostic personnalisé.</div>
      )}
    </section>
  );
}

/* ============================================================
   APP
   ============================================================ */

export default function App() {
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("week");
  const [offset, setOffset] = useState(0); // 0 = période la plus récente
  const [activeTab, setActiveTab] = useState("ventes");
  const [chartKpi, setChartKpi] = useState({}); // index du KPI affiché dans le graphique, par onglet
  const isDesktop = useIsDesktop();

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      setData(await loadSheetData());
      setStatus("ready");
    } catch (e) {
      setError(e.message || String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const periodData = data?.[mode];
  const periods = periodData?.periods || [];
  const idx = Math.max(0, periods.length - 1 - offset);
  const health = useMemo(() => computeHealth(periodData, idx), [periodData, idx]);

  const switchMode = (m) => {
    setMode(m);
    setOffset(0);
  };

  const tab = TABS.find((t) => t.id === activeTab);
  const kpis = tab ? periodData?.tabs[tab.id] || [] : [];
  const selectedKpi = kpis[chartKpi[activeTab] ?? 0];

  return (
    <div className="fb-root">
      <style>{CSS}</style>

      {/* ---------- HEADER FIXE ---------- */}
      <header className="fb-header">
        <div className="fb-container">
          <div className="fb-header-row">
            <div className="fb-brand">
              <div className="fb-logo">
                Flow<span>Board</span>
              </div>
              <div className="fb-client">{data?.client?.name || (status === "loading" ? "Chargement…" : "—")}</div>
              {data?.client?.activity && <div className="fb-activity">{data.client.activity}</div>}
            </div>
            <HealthRing score={status === "ready" ? health : null} />
          </div>

          <div className="fb-header-row fb-controls">
            <div className="fb-segment" role="tablist">
              {[
                ["week", "Semaine"],
                ["month", "Mois"],
              ].map(([m, label]) => (
                <button key={m} className={mode === m ? "is-active" : ""} onClick={() => switchMode(m)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="fb-period">
              <button
                className="fb-arrow"
                aria-label="Période précédente"
                disabled={status !== "ready" || idx <= 0}
                onClick={() => setOffset((o) => o + 1)}
              >
                ‹
              </button>
              <div className="fb-period-label">
                <strong>{periods[idx] || "—"}</strong>
                <span>{periods[idx - 1] ? `vs ${periods[idx - 1]}` : "1re période"}</span>
              </div>
              <button
                className="fb-arrow"
                aria-label="Période suivante"
                disabled={status !== "ready" || offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - 1))}
              >
                ›
              </button>
            </div>
          </div>

          <nav className="fb-tabs">
            {ALL_TABS.map((t) => (
              <button
                key={t.id}
                className={`fb-tab ${activeTab === t.id ? "is-active" : ""}`}
                onClick={() => setActiveTab(t.id)}
              >
                <span>{t.icon}</span> {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ---------- CONTENU ---------- */}
      <main className="fb-container fb-main">
        {status === "loading" && (
          <div className="fb-state">
            <span className="fb-spinner" />
            <p>Chargement des données du Google Sheet…</p>
            <div className="fb-grid fb-grid-skeleton">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="fb-card fb-card-skel" />
              ))}
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="fb-state fb-error">
            <div className="fb-error-icon">⚠️</div>
            <h2>Impossible de charger les données</h2>
            <p>
              Vérifiez que le lien du Google Sheet est correct et que le document est bien publié sur le web
              (Fichier → Partager → Publier sur le web → <em>Document entier</em>).
            </p>
            <code className="fb-error-detail">{error}</code>
            <div className="fb-error-actions">
              <button className="fb-btn" onClick={load}>
                ↻ Réessayer
              </button>
              <a className="fb-btn fb-btn-ghost" href={SHEET_URL} target="_blank" rel="noreferrer">
                Ouvrir le lien
              </a>
            </div>
          </div>
        )}

        {status === "ready" && tab && (
          <>
            <div className="fb-section-title">
              <h1>
                {tab.icon} {tab.label}
              </h1>
              <span>
                {mode === "week" ? "Vue hebdomadaire" : "Vue mensuelle"} · {periods[idx]}
              </span>
            </div>
            <div className="fb-grid">
              {kpis.map((kpi, i) => (
                <KpiCard
                  key={kpi.name + i}
                  kpi={kpi}
                  idx={idx}
                  active={(chartKpi[activeTab] ?? 0) === i}
                  onClick={() => setChartKpi((s) => ({ ...s, [activeTab]: i }))}
                />
              ))}
            </div>
            {selectedKpi && <KpiChart kpi={selectedKpi} periods={periods} idx={idx} isDesktop={isDesktop} />}
          </>
        )}

        {status === "ready" && activeTab === "ia" && (
          <AiPanel data={data} mode={mode} idx={idx} client={data.client} health={health} />
        )}

        <footer className="fb-footer">FlowBoard · données synchronisées depuis Google Sheets</footer>
      </main>
    </div>
  );
}

/* ============================================================
   STYLES (mobile-first, puis desktop ≥ 900px)
   ============================================================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: ${COLORS.bg}; }
.fb-root {
  min-height: 100vh;
  background: ${COLORS.bg};
  color: ${COLORS.text};
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}
.fb-root button { font-family: inherit; }
.fb-container { width: 100%; max-width: 430px; margin: 0 auto; padding: 0 16px; }

/* Header */
.fb-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(7, 9, 15, 0.88);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid ${COLORS.borderSoft};
  padding-top: 12px;
}
.fb-header-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.fb-brand { min-width: 0; }
.fb-logo { font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: ${COLORS.muted}; }
.fb-logo span { color: ${COLORS.accent}; }
.fb-client { font-size: 20px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fb-activity { font-size: 12px; color: ${COLORS.muted}; }
.fb-health { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.fb-health-label { display: none; flex-direction: column; font-size: 11px; color: ${COLORS.muted}; }
.fb-health-label strong { font-size: 13px; }

.fb-controls { margin-top: 12px; }
.fb-segment { display: flex; background: ${COLORS.card}; border: 1px solid ${COLORS.borderSoft}; border-radius: 12px; padding: 3px; }
.fb-segment button {
  border: 0; background: transparent; color: ${COLORS.muted};
  padding: 7px 12px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: .2s;
}
.fb-segment button.is-active { background: ${COLORS.accent}; color: ${COLORS.bg}; }
.fb-period { display: flex; align-items: center; gap: 6px; }
.fb-period-label { display: flex; flex-direction: column; align-items: center; min-width: 74px; line-height: 1.2; }
.fb-period-label strong { font-size: 14px; }
.fb-period-label span { font-size: 11px; color: ${COLORS.muted}; }
.fb-arrow {
  width: 34px; height: 34px; border-radius: 10px; cursor: pointer;
  border: 1px solid ${COLORS.borderSoft}; background: ${COLORS.card}; color: ${COLORS.text};
  font-size: 20px; line-height: 1; display: grid; place-items: center; transition: .2s;
}
.fb-arrow:hover:not(:disabled) { border-color: ${COLORS.accent}; color: ${COLORS.accent}; }
.fb-arrow:disabled { opacity: .3; cursor: not-allowed; }

.fb-tabs {
  display: flex; gap: 6px; overflow-x: auto; margin: 12px -16px 0; padding: 0 16px 10px;
  scrollbar-width: none;
}
.fb-tabs::-webkit-scrollbar { display: none; }
.fb-tab {
  flex-shrink: 0; border: 1px solid ${COLORS.borderSoft}; background: transparent; color: ${COLORS.muted};
  padding: 8px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; transition: .2s;
  white-space: nowrap;
}
.fb-tab:hover { color: ${COLORS.text}; }
.fb-tab.is-active { background: rgba(200, 244, 100, .12); border-color: ${COLORS.accent}; color: ${COLORS.accent}; }

/* Main */
.fb-main { padding-top: 18px; padding-bottom: 32px; }
.fb-section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.fb-section-title h1 { font-size: 18px; margin: 0; }
.fb-section-title span { font-size: 12px; color: ${COLORS.muted}; }

.fb-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fb-card {
  text-align: left; color: ${COLORS.text}; cursor: pointer;
  background: ${COLORS.card}; border: 1px solid ${COLORS.borderSoft}; border-radius: 16px;
  padding: 14px; display: flex; flex-direction: column; gap: 6px; min-height: 118px;
  transition: border-color .2s, transform .2s, background .2s;
}
.fb-card:hover { background: ${COLORS.cardHover}; transform: translateY(-2px); }
.fb-card.is-active { border-color: ${COLORS.accent}; box-shadow: 0 0 0 1px ${COLORS.accent}33, 0 8px 24px -12px ${COLORS.accent}55; }
.fb-card-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.fb-card-icon {
  width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center;
  background: rgba(255,255,255,.05); font-size: 16px;
}
.fb-trend { font-size: 11px; font-weight: 700; padding: 3px 7px; border-radius: 999px; white-space: nowrap; }
.fb-card-value { font-size: 21px; font-weight: 800; letter-spacing: -.02em; margin-top: 4px; }
.fb-card-name { font-size: 12px; color: ${COLORS.muted}; }

.fb-chart, .fb-ai {
  margin-top: 14px; background: ${COLORS.card}; border: 1px solid ${COLORS.borderSoft};
  border-radius: 18px; padding: 16px 14px 10px;
}
.fb-chart-head, .fb-ai-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.fb-chart-title { font-weight: 700; font-size: 15px; }
.fb-chart-sub { font-size: 12px; color: ${COLORS.muted}; margin-top: 2px; }
.fb-chart-sub strong { color: ${COLORS.text}; }
.fb-chart-current { font-weight: 800; font-size: 18px; color: ${COLORS.accent}; white-space: nowrap; }
.fb-tooltip { background: ${COLORS.bg}; border: 1px solid ${COLORS.border}; border-radius: 10px; padding: 8px 10px; }
.fb-tooltip-label { font-size: 11px; color: ${COLORS.muted}; }
.fb-tooltip-value { font-weight: 700; color: ${COLORS.accent}; }

/* IA */
.fb-ai { padding: 16px; }
.fb-ai-head { flex-direction: column; }
.fb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  background: ${COLORS.accent}; color: ${COLORS.bg}; border: 0; border-radius: 12px;
  padding: 11px 18px; font-weight: 700; font-size: 14px; cursor: pointer; text-decoration: none; transition: .2s;
}
.fb-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
.fb-btn:disabled { opacity: .7; cursor: progress; }
.fb-btn-ghost { background: transparent; color: ${COLORS.text}; border: 1px solid ${COLORS.borderSoft}; }
.fb-ai-head .fb-btn { width: 100%; }
.fb-ai-empty { font-size: 13px; color: ${COLORS.muted}; padding: 18px 0 8px; text-align: center; }
.fb-ai-meta { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: ${COLORS.accent}; margin-bottom: 8px; }
.fb-ai-result { border-top: 1px solid ${COLORS.borderSoft}; padding-top: 12px; margin-top: 4px; }
.fb-rich { font-size: 14px; line-height: 1.6; }
.fb-rich h4 { margin: 14px 0 6px; font-size: 14px; color: ${COLORS.accent}; }
.fb-rich p { margin: 0 0 6px; }
.fb-rich strong { color: ${COLORS.text}; }
.fb-li { position: relative; padding-left: 16px; margin-bottom: 6px; color: #C9CEE0; }
.fb-li::before { content: ''; position: absolute; left: 2px; top: 9px; width: 6px; height: 6px; border-radius: 50%; background: ${COLORS.accent}; }
.fb-li-num { padding-left: 0; }
.fb-li-num::before { display: none; }
.fb-ai-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 12px 0; }
.fb-skel, .fb-card-skel {
  background: linear-gradient(90deg, rgba(255,255,255,.04) 25%, rgba(255,255,255,.09) 50%, rgba(255,255,255,.04) 75%);
  background-size: 200% 100%; animation: fb-shimmer 1.4s infinite;
}
.fb-skel { height: 12px; border-radius: 6px; }
.fb-card-skel { cursor: default; }
.fb-alert {
  margin-top: 12px; padding: 12px; border-radius: 12px; font-size: 13px;
  background: rgba(255, 107, 122, .1); border: 1px solid rgba(255, 107, 122, .3); color: #FFC2C9;
}
.fb-alert-hint { margin-top: 6px; color: ${COLORS.muted}; }
.fb-root code { background: rgba(255,255,255,.06); padding: 2px 6px; border-radius: 6px; font-size: 12px; }

/* États */
.fb-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px 0; gap: 12px; color: ${COLORS.muted}; }
.fb-state .fb-grid { width: 100%; margin-top: 12px; }
.fb-spinner {
  width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid rgba(200, 244, 100, .15); border-top-color: ${COLORS.accent};
  animation: fb-spin .8s linear infinite;
}
.fb-spinner-sm { width: 16px; height: 16px; border-width: 2px; border-color: rgba(7,9,15,.25); border-top-color: ${COLORS.bg}; }
.fb-error { background: ${COLORS.card}; border: 1px solid rgba(255, 107, 122, .3); border-radius: 18px; padding: 28px 20px; margin-top: 8px; }
.fb-error-icon { font-size: 36px; }
.fb-error h2 { color: ${COLORS.text}; font-size: 18px; margin: 0; }
.fb-error p { margin: 0; font-size: 14px; line-height: 1.6; max-width: 480px; }
.fb-error-detail { color: ${COLORS.red}; }
.fb-error-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }

.fb-footer { text-align: center; font-size: 11px; color: ${COLORS.muted}; opacity: .6; margin-top: 28px; }

@keyframes fb-spin { to { transform: rotate(360deg); } }
@keyframes fb-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

/* ---------- Desktop ---------- */
@media (min-width: 900px) {
  .fb-container { max-width: 1200px; padding: 0 32px; }
  .fb-header { padding-top: 18px; }
  .fb-client { font-size: 26px; }
  .fb-health-label { display: flex; }
  .fb-tabs { margin: 16px 0 0; padding: 0 0 14px; }
  .fb-tab { padding: 9px 16px; font-size: 14px; }
  .fb-main { padding-top: 28px; }
  .fb-section-title h1 { font-size: 24px; }
  .fb-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .fb-card { padding: 20px; min-height: 148px; border-radius: 18px; }
  .fb-card-icon { width: 40px; height: 40px; font-size: 20px; }
  .fb-card-value { font-size: 30px; }
  .fb-card-name { font-size: 13px; }
  .fb-trend { font-size: 12px; }
  .fb-chart { margin-top: 20px; padding: 22px 22px 14px; }
  .fb-chart-title { font-size: 17px; }
  .fb-chart-current { font-size: 24px; }
  .fb-ai { padding: 24px; max-width: 860px; margin: 0 auto; }
  .fb-ai-head { flex-direction: row; align-items: center; }
  .fb-ai-head .fb-btn { width: auto; }
  .fb-rich { font-size: 15px; }
}
`;

