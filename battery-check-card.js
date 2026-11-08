/*
 * Battery Check Card — a Home Assistant dashboard card that finds every battery in your home and tells you which ones
 * to replace now. Full colour = something to do, dimmed = fine.
 *
 * Finds sensors with device_class "battery" (percent) and binary sensors with device_class "battery" (on = low)
 * by itself; groups them by what the device does (or by area) and keeps phones, watches and trackers apart.
 * https://github.com/AldebaranPrimo/battery-check-card — MIT licence.
 */
const VERSION = "1.0.0";

const STRINGS = {
  en: {
    title: "Batteries",
    replace: (names) => `Replace batteries: ${names}`,
    watch: (names) => `Batteries running low: ${names}`,
    allGood: (low) => `All batteries above ${low}%`,
    summaryBad: (n, w, m, ok) => `${n} to replace · ${w} running low · ${m} not responding · ${ok} fine`,
    summaryWatch: (c, m, ok) => `None below ${c}% · ${m} not responding · ${ok} fine`,
    summaryGood: (ok, m) => `${ok} sensors · ${m} not responding`,
    head: (s, m) => `${s} sensors · ${m} mobile devices`,
    groupReplace: (c) => (c === null ? "Replace" : `Replace (below ${c}%)`),
    groupWatch: (c, l) => `Keep an eye on (${c}–${l}%)`,
    groupDead: "Not responding",
    groupOk: (l) => `Fine (${l}% and above)`,
    groupMobile: "Phones, watches and trackers",
    low: "low",
    changed: (t) => `changed ${t}`,
    silent: (t) => `last data ${t}`,
    trend: "last 30 days",
    charging: "charging", full: "fully charged", discharging: "in use", notCharging: "not charging",
    and: "and", more: (n) => `${n} more`,
    footer: "Tap a battery for its details.",
    none: "No batteries found. Check that your battery sensors have device_class: battery.",
    categories: { safety: "Safety", openings: "Doors and windows", motion: "Motion", climate: "Climate",
      buttons: "Buttons and remotes", other: "Other", noArea: "No area" },
  },
  it: {
    title: "Pile",
    replace: (names) => `Cambia le pile: ${names}`,
    watch: (names) => `Pile in calo: ${names}`,
    allGood: (low) => `Tutte le pile sopra il ${low}%`,
    summaryBad: (n, w, m, ok) => `${n} da cambiare · ${w} in calo · ${m} non rispondono · ${ok} a posto`,
    summaryWatch: (c, m, ok) => `Nessuna sotto il ${c}% · ${m} non rispondono · ${ok} a posto`,
    summaryGood: (ok, m) => `${ok} sensori · ${m} non rispondono`,
    head: (s, m) => `${s} sensori · ${m} dispositivi mobili`,
    groupReplace: (c) => (c === null ? "Da cambiare" : `Da cambiare (sotto il ${c}%)`),
    groupWatch: (c, l) => `Da tenere d'occhio (${c}-${l}%)`,
    groupDead: "Non rispondono",
    groupOk: (l) => `A posto (dal ${l}% in su)`,
    groupMobile: "Telefoni, orologi e tracker",
    low: "bassa",
    changed: (t) => `cambiato ${t}`,
    silent: (t) => `ultimo dato ${t}`,
    trend: "ultimi 30 giorni",
    charging: "in carica", full: "carica completa", discharging: "in uso", notCharging: "non in carica",
    and: "e", more: (n) => `altre ${n}`,
    footer: "Tocca una pila per i dettagli.",
    none: "Nessuna pila trovata. Controlla che i sensori delle pile abbiano device_class: battery.",
    categories: { safety: "Sicurezza", openings: "Porte e finestre", motion: "Movimento", climate: "Clima",
      buttons: "Pulsanti e telecomandi", other: "Altro", noArea: "Senza area" },
  },
};

const COLORS = {
  red: ["#d6453d", "#ffffff"],
  amber: ["#f2a33a", "#2a1a00"],
  blue: ["#3d7be0", "#ffffff"],
  green: ["#3aa55c", "#ffffff"],
  grey: ["#6b7078", "#ffffff"],
};
const UNAVAILABLE = ["unavailable", "unknown", "none", ""];

// Category from the other entities of the same device, in this order (the first match wins).
const CATEGORY_RULES = [
  ["safety", ["smoke", "carbon_monoxide", "gas", "moisture", "safety", "problem"]],
  ["openings", ["door", "window", "opening", "garage_door", "lock"]],
  ["motion", ["motion", "occupancy", "presence", "vibration"]],
  ["climate", ["temperature", "humidity", "atmospheric_pressure", "pressure", "co2", "carbon_dioxide", "pm25", "volatile_organic_compounds", "volatile_organic_compounds_parts"]],
  ["buttons", ["button", "event", "remote"]],
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (st) => {
  if (!st || UNAVAILABLE.includes(String(st.state).toLowerCase())) return null;
  const v = parseFloat(st.state);
  return Number.isFinite(v) ? v : null;
};
const glob = (pattern) => new RegExp("^" + String(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

class BatteryCheckCard extends HTMLElement {
  static getStubConfig() { return {}; }

  setConfig(config) {
    for (const k of ["exclude", "include", "mobile"]) if (config[k] !== undefined && !Array.isArray(config[k])) throw new Error(`${k} must be a list`);
    if (config.names !== undefined && (typeof config.names !== "object" || Array.isArray(config.names))) throw new Error("names must be a map of entity_id: name");
    if (config.group_by !== undefined && !["category", "area", "none"].includes(config.group_by)) throw new Error("group_by must be category, area or none");
    this._config = { critical: 20, low: 50, exclude: [], include: [], mobile: [], names: {}, group_by: "category",
      show_mobile: true, show_ok: true, show_storage: false, trend: true, ...config };
    if (!(this._config.critical < this._config.low)) throw new Error("critical must be lower than low");
    this._exclude = this._config.exclude.map(glob);
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._sig = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const d = this._data();
    const sig = d.all.map((b) => `${b.id}=${b.st?.state}`).join("|") + "|" + Math.floor(Date.now() / 300000) + "|" + this._lang().locale;
    if (sig === this._sig) return;
    this._sig = sig;
    this._render(d);
    if (this._config.trend) this._loadTrend(d);
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: "full" }; }

  _lang() {
    const loc = this._config.language || this._hass?.locale?.language || this._hass?.language || "en";
    const short = String(loc).slice(0, 2).toLowerCase();
    return { s: STRINGS[short] || STRINGS.en, locale: loc };
  }
  _fmt(v) { return new Intl.NumberFormat(this._lang().locale, { maximumFractionDigits: 0 }).format(v); }
  _ago(date) {
    const sec = (new Date(date) - Date.now()) / 1000;
    if (!Number.isFinite(sec)) return "";
    const rtf = new Intl.RelativeTimeFormat(this._lang().locale, { numeric: "auto" });
    const a = Math.abs(sec);
    if (a < 3600) return rtf.format(Math.round(sec / 60), "minute");
    if (a < 129600) return rtf.format(Math.round(sec / 3600), "hour");
    return rtf.format(Math.round(sec / 86400), "day");
  }
  _list(names, max = 4) {
    const { s } = this._lang();
    const n = names.slice(0, max), rest = names.length - n.length;
    if (rest > 0) n.push(s.more(rest));
    return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} ${s.and} ${n[n.length - 1]}`;
  }

  // Everything the card shows, worked out from hass.states plus the entity and device registries.
  _data() {
    const c = this._config, h = this._hass, states = h?.states || {}, reg = h?.entities || {}, devs = h?.devices || {}, areas = h?.areas || {};
    const siblings = {};
    for (const [id, e] of Object.entries(reg)) if (e.device_id) (siblings[e.device_id] = siblings[e.device_id] || []).push(id);
    const kinds = (dev, self) => (siblings[dev] || []).filter((x) => x !== self).map((x) => states[x]?.attributes?.device_class || x.split(".")[0]);
    const excluded = (id) => this._exclude.some((r) => r.test(id));

    const pctIds = Object.keys(states).filter((id) => (id.startsWith("sensor.") && states[id].attributes.device_class === "battery") || c.include.includes(id));
    const devWithPct = new Set(pctIds.map((id) => reg[id]?.device_id).filter(Boolean));
    const lowIds = Object.keys(states).filter((id) => id.startsWith("binary_sensor.") && states[id].attributes.device_class === "battery");
    // devices with a percent sensor whose low-battery binary sensor says "low": their percent tile goes in Replace
    const flaggedDev = new Set(lowIds.filter((id) => !excluded(id) && states[id].state === "on" && devWithPct.has(reg[id]?.device_id)).map((id) => reg[id].device_id));

    const make = (id, binary) => {
      const st = states[id], e = reg[id] || {}, dev = devs[e.device_id] || {};
      const k = kinds(e.device_id, id);
      const chargeId = id.replace(/_battery_level(_\d+)?$/, "_battery_state$1");
      const charge = chargeId !== id && states[chargeId] ? states[chargeId].state : null;
      const mobile = c.mobile.includes(id) || charge !== null || k.includes("device_tracker");
      const storage = !mobile && k.includes("current") && (k.includes("voltage") || k.includes("power"));
      const category = (CATEGORY_RULES.find(([, cls]) => cls.some((x) => k.includes(x))) || ["other"])[0];
      const areaId = e.area_id || dev.area_id;
      const raw = c.names[id] || st.attributes.friendly_name || "";
      let name = raw.replace(/\s*(battery(\s*(level|low))?|batteria(\s*(livello|bassa|scarica))?)\s*$/i, "").trim();
      if (!name) name = dev.name_by_user || dev.name || id;
      if (!c.names[id]) name = name.replace(/^./, (x) => x.toUpperCase());
      return { id, st, name, binary, value: binary ? null : num(st), lowFlag: binary && st.state === "on", flagged: !binary && flaggedDev.has(e.device_id), deadBinary: binary && UNAVAILABLE.includes(st.state),
        mobile, storage, category, area: areaId && areas[areaId] ? areas[areaId].name : null, charge };
    };

    const all = [
      ...pctIds.filter((id) => !excluded(id)).map((id) => make(id, false)),
      // a low-battery binary sensor is a tile of its own only when its device has no percent sensor
      ...lowIds.filter((id) => !excluded(id) && !devWithPct.has(reg[id]?.device_id)).map((id) => make(id, true)),
    ].filter((b) => c.show_storage || !b.storage);

    const fixed = all.filter((b) => !b.mobile);
    const order = (a, b) => (a.value ?? 999) - (b.value ?? 999) || a.name.localeCompare(b.name);
    const pctFixed = fixed.filter((b) => !b.binary);
    return {
      all,
      replace: [...pctFixed.filter((b) => b.flagged || (b.value !== null && b.value < c.critical)).sort(order), ...fixed.filter((b) => b.lowFlag)],
      watch: pctFixed.filter((b) => !b.flagged && b.value !== null && b.value >= c.critical && b.value < c.low).sort(order),
      ok: [...pctFixed.filter((b) => !b.flagged && b.value !== null && b.value >= c.low).sort(order),
        ...fixed.filter((b) => b.binary && !b.lowFlag && !b.deadBinary)],
      dead: fixed.filter((b) => !b.flagged && (b.binary ? b.deadBinary : b.value === null)).sort((a, b) => a.name.localeCompare(b.name)),
      mobile: all.filter((b) => b.mobile).sort(order),
    };
  }

  // 30-day daily means for the batteries that need attention, from long-term statistics (refreshed every 30 minutes)
  async _loadTrend(d) {
    const ids = [...d.replace, ...d.watch].filter((b) => !b.binary).map((b) => b.id);
    const key = ids.join(",");
    if (!ids.length || !this._hass?.callWS || (this._trendKey === key && Date.now() - this._trendAt < 1800000)) return;
    this._trendKey = key; this._trendAt = Date.now();
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 29);
    try {
      const r = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: start.toISOString(), period: "day", statistic_ids: ids, types: ["mean"] });
      this._trend = {};
      for (const [id, rows] of Object.entries(r || {})) {
        const pts = rows.map((x) => ({ t: new Date(x.start).getTime(), v: x.mean })).filter((x) => Number.isFinite(x.v) && Number.isFinite(x.t));
        if (pts.length > 1) this._trend[id] = { pts, t0: start.getTime() };
      }
    } catch (e) { this._trend = {}; }
    this._render();
  }
  _spark(id) {
    const tr = this._trend?.[id];
    if (!tr) return "";
    const X = (t) => Math.min(100, Math.max(0, ((t - tr.t0) / (30 * 86400000)) * 100)), Y = (v) => 20 - (Math.min(100, Math.max(0, v)) / 100) * 18;
    const path = tr.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    return `<svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none" role="img" aria-label="${esc(this._lang().s.trend)}"><path d="${path}"/></svg>`;
  }

  _tile(b, color, cls) {
    const { s } = this._lang(), [c, t] = COLORS[color];
    const value = b.value !== null ? `${this._fmt(b.value)}<small>%</small>` : b.lowFlag || b.flagged ? esc(s.low) : "—";
    const detail = (b.binary ? b.deadBinary : b.value === null) ? s.silent(this._ago(b.st.last_changed)) : s.changed(this._ago(b.st.last_changed));
    const cat = this._config.group_by === "area" ? (b.area || s.categories.noArea) : s.categories[b.category];
    const icon = b.value === null && !b.lowFlag && !b.flagged ? "mdi:battery-unknown" : b.lowFlag || b.flagged || b.value < this._config.critical ? "mdi:battery-alert-variant-outline" : "mdi:battery-50";
    return `<div class="tile ${cls}" style="--c:${c};--t:${t}" data-entity="${esc(b.id)}" title="${esc(b.id)}" role="button" tabindex="0">
      <div class="row"><ha-icon icon="${icon}"></ha-icon><span class="name">${esc(b.name)}</span></div>
      <div class="value">${value}</div>
      ${b.value !== null ? `<div class="bar"><i style="width:${Math.max(2, Math.min(100, b.value))}%"></i></div>` : ""}
      ${cls !== "dim" ? this._spark(b.id) : ""}
      <div class="detail">${this._config.group_by === "none" ? "" : `${esc(cat)} · `}${esc(detail)}</div></div>`;
  }

  _chip(b) {
    const ok = COLORS.green;
    const v = b.binary ? "" : ` <b>${this._fmt(b.value)}%</b>`;
    return `<span class="chip dim" style="--c:${ok[0]};--t:${ok[1]}" data-entity="${esc(b.id)}" title="${esc(b.id)}" role="button" tabindex="0"><ha-icon icon="mdi:battery-high"></ha-icon>${esc(b.name)}${v}</span>`;
  }

  _mobileChip(b) {
    const { s } = this._lang(), c = this._config;
    const charging = ["charging", "full"].includes(b.charge);
    const bad = b.value !== null && b.value < c.critical && !charging;
    const [k, t] = bad ? COLORS.red : COLORS.blue;
    const text = { charging: s.charging, full: s.full, discharging: s.discharging, not_charging: s.notCharging }[b.charge] || "";
    return `<span class="chip ${bad ? "full" : "dim"}" style="--c:${k};--t:${t}" data-entity="${esc(b.id)}" title="${esc(b.id)}" role="button" tabindex="0">
      <ha-icon icon="${charging ? "mdi:battery-charging" : "mdi:cellphone"}"></ha-icon>${esc(b.name)} <b>${b.value === null ? "—" : this._fmt(b.value) + "%"}</b>${text ? " · " + esc(text) : ""}</span>`;
  }

  _render(d) {
    if (!this.shadowRoot || !this._config || !this._hass) return;
    d = d || this._data();
    const c = this._config, { s } = this._lang();
    const names = (list) => this._list(list.map((b) => b.name));
    let banner;
    if (d.replace.length) banner = ["red", "mdi:battery-alert-variant-outline", s.replace(names(d.replace)), s.summaryBad(d.replace.length, d.watch.length, d.dead.length, d.ok.length)];
    else if (d.watch.length) banner = ["amber", "mdi:battery-50", s.watch(names(d.watch)), s.summaryWatch(c.critical, d.dead.length, d.ok.length)];
    else banner = [null, "mdi:battery-check", s.allGood(c.low), s.summaryGood(d.ok.length, d.dead.length)];
    const [bc, bi, bt, bs] = banner;

    let okHtml = "";
    if (c.show_ok && d.ok.length) {
      if (c.group_by === "none") okHtml = `<div class="group">${esc(s.groupOk(c.low))}</div><div class="chips">${d.ok.map((b) => this._chip(b)).join("")}</div>`;
      else {
        const groups = {};
        for (const b of d.ok) {
          const g = c.group_by === "area" ? (b.area || s.categories.noArea) : s.categories[b.category];
          (groups[g] = groups[g] || []).push(b);
        }
        const last = [s.categories.other, s.categories.noArea];
        okHtml = Object.entries(groups).sort((a, b) => last.includes(a[0]) - last.includes(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]))
          .map(([g, list]) => `<div class="group">${esc(s.groupOk(c.low))} · ${esc(g)}</div><div class="chips">${list.map((b) => this._chip(b)).join("")}</div>`).join("");
      }
    }

    const fixedCount = d.all.length - d.mobile.length;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>
      <div class="head"><h2>${esc(c.title ?? s.title)}</h2><span class="note">${esc(s.head(fixedCount, d.mobile.length))}</span></div>
      ${d.all.length ? `<div class="banner ${bc ? "" : "calm"}" ${bc ? `style="--ac:${COLORS[bc][0]};--at:${COLORS[bc][1]}"` : ""}>
        <ha-icon icon="${bi}"></ha-icon><div><b>${esc(bt)}</b><span>${esc(bs)}</span></div></div>` : `<div class="banner calm"><ha-icon icon="mdi:battery-unknown"></ha-icon><div><b>${esc(s.none)}</b></div></div>`}
      ${d.replace.length ? `<div class="group">${esc(s.groupReplace(d.replace.some((b) => b.flagged || b.lowFlag) ? null : c.critical))}</div><div class="tiles">${d.replace.map((b) => this._tile(b, "red", "full")).join("")}</div>` : ""}
      ${d.watch.length ? `<div class="group">${esc(s.groupWatch(c.critical, c.low))}</div><div class="tiles">${d.watch.map((b) => this._tile(b, "amber", "")).join("")}</div>` : ""}
      ${d.dead.length ? `<div class="group">${esc(s.groupDead)}</div><div class="tiles">${d.dead.map((b) => this._tile(b, "grey", "dim")).join("")}</div>` : ""}
      ${okHtml}
      ${c.show_mobile && d.mobile.length ? `<div class="group">${esc(s.groupMobile)}</div><div class="chips">${d.mobile.map((b) => this._mobileChip(b)).join("")}</div>` : ""}
      ${d.all.length ? `<div class="foot">${esc(s.footer)}</div>` : ""}
    </ha-card>`;
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) => {
      const open = () => this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: el.dataset.entity } }));
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }
}

const STYLE = `
  :host { display: block; container: bcc / inline-size; }
  ha-card { display: block; padding: 16px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .head h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .head .note { font-size: .78rem; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .banner { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; margin-bottom: 14px; background: var(--ac); color: var(--at); }
  .banner.calm { background: color-mix(in srgb, var(--secondary-text-color) 8%, transparent); color: inherit;
    border: 1px solid color-mix(in srgb, var(--secondary-text-color) 20%, transparent); }
  .banner ha-icon { --mdc-icon-size: 28px; flex: none; }
  .banner.calm ha-icon { color: var(--secondary-text-color); }
  .banner b { display: block; font-size: 1.08rem; line-height: 1.25; text-wrap: balance; overflow-wrap: anywhere; }
  .banner span { display: block; font-size: .84rem; opacity: .88; margin-top: 2px; }
  .banner.calm span { color: var(--secondary-text-color); opacity: 1; }
  .group { margin: 14px 0 6px; font-size: .7rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .tile { --c: #6b7078; --t: #fff; display: flex; flex-direction: column; gap: 3px; padding: 10px 10px 9px; border-radius: 14px; min-width: 0;
    cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
    background: color-mix(in srgb, var(--c) 22%, var(--ha-card-background, var(--card-background-color, #1f2125)));
    border: 1px solid color-mix(in srgb, var(--c) 55%, transparent); }
  .tile.dim { opacity: .5; }
  .tile.full { background: var(--c); color: var(--t); border: 2px solid var(--c); box-shadow: 0 0 16px color-mix(in srgb, var(--c) 50%, transparent); }
  .tile .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .tile ha-icon { --mdc-icon-size: 20px; color: var(--c); flex: none; }
  .tile.full ha-icon { color: var(--t); }
  .tile .name { font-size: .78rem; font-weight: 600; line-height: 1.2; min-width: 0; overflow-wrap: anywhere; }
  .tile .value { font-size: 1.35rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .tile .value small { font-size: .75rem; font-weight: 600; opacity: .8; margin-left: 2px; }
  .tile .detail { font-size: .7rem; opacity: .85; line-height: 1.3; overflow-wrap: anywhere; }
  .tile:not(.full) .detail { color: var(--secondary-text-color); opacity: 1; }
  .bar { height: 5px; border-radius: 3px; background: color-mix(in srgb, currentColor 18%, transparent); overflow: hidden; margin-top: 2px; }
  .bar i { display: block; height: 100%; background: var(--c); border-radius: 3px; }
  .tile.full .bar i { background: var(--t); }
  svg.spark { width: 100%; height: 22px; display: block; margin-top: 2px; overflow: visible; }
  svg.spark path { fill: none; stroke: var(--c); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
  .tile.full svg.spark path { stroke: var(--t); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { --c: #6b7078; --t: #fff; display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px 4px 8px; border-radius: 999px;
    font-size: .76rem; cursor: pointer; font-variant-numeric: tabular-nums; max-width: 100%; box-sizing: border-box; overflow-wrap: anywhere;
    background: color-mix(in srgb, var(--c) 20%, transparent); border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .chip ha-icon { --mdc-icon-size: 16px; color: var(--c); flex: none; }
  .chip.dim { opacity: .6; }
  .chip.full { background: var(--c); color: var(--t); border-color: var(--c); font-weight: 600; }
  .chip.full ha-icon { color: var(--t); }
  .chip b { font-weight: 700; white-space: nowrap; }
  .foot { margin-top: 12px; font-size: .72rem; color: var(--secondary-text-color); }
  @container bcc (max-width: 420px) {
    ha-card { padding: 12px; }
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
    .tile { padding: 8px 8px 7px; }
    .tile .value { font-size: 1.15rem; }
  }
`;

if (!customElements.get("battery-check-card")) customElements.define("battery-check-card", BatteryCheckCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((x) => x.type === "battery-check-card")) {
  window.customCards.push({ type: "battery-check-card", name: "Battery Check Card", preview: true,
    description: "Finds every battery in your home and shows which ones to replace now." });
}
console.info(`%c BATTERY-CHECK-CARD %c ${VERSION} `, "color:#fff;background:#d6453d;font-weight:700", "color:#d6453d;background:#fff");
