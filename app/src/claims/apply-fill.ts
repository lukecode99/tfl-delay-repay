// Apply-form direct fill (TfL-21). Pure module — node-testable.
//
// The keyword-heuristic buildFillScript (prefill.ts) fills text inputs well
// but can't reliably drive the Apply form's dropdowns: the transport **Mode**
// <select> and — worse — the two **station** typeaheads, which don't expose an
// <option> list to match a name against; they set a HIDDEN numeric field
// (StartNlcId / FinishNlcId) from an autocomplete. TfL-20 captured the real
// POST, so we now know the exact field names and the numeric values behind
// those widgets. This module fills the form by those exact names instead of
// guessing — deterministic, and it survives TfL restyling the widgets.
//
// Captured Apply POST (contactless.tfl.gov.uk/ServiceDelayRefunds/Apply):
//   CardDisplayId, ModeId, StartNlcId, FinishNlcId, JourneyDate (DD/MM/YYYY),
//   JourneyStartTimeHours, JourneyStartTimeMins, DelayLengthString.
// ModeId: 0=London Underground, 20=London Overground, 5=DLR, 101=Elizabeth
// line (confirmed by the form's own ModeInfosJson map).
//
// Script kept as ES5 source text (Hermes' Function.prototype.toString returns
// "[bytecode]"); the tests run this exact string against a stub DOM. Zero
// runtime imports, same convention as prefill.ts / claim-capture.ts.
import type { Assessment } from '../eligibility/engine';
import type { ParsedJourney } from '../journeys/parse';
import { lookupNlc } from './nlc-map';

/** Transport ModeId as the Apply form expects it, keyed by ledger line id. */
export const MODE_ID_BY_LINE: Record<string, number> = {
  // London Underground lines → 0
  bakerloo: 0, central: 0, circle: 0, district: 0, 'hammersmith-city': 0,
  jubilee: 0, metropolitan: 0, northern: 0, piccadilly: 0, victoria: 0,
  'waterloo-city': 0,
  // DLR → 5
  dlr: 5,
  // Elizabeth line → 101
  elizabeth: 101,
  // London Overground (incl. the 2024 named lines) → 20
  'london-overground': 20, liberty: 20, lioness: 20, mildmay: 20,
  suffragette: 20, weaver: 20, windrush: 20,
};

export function modeIdForLine(lineId: string | undefined): number | null {
  if (!lineId) return null;
  const m = MODE_ID_BY_LINE[lineId];
  return typeof m === 'number' ? m : null;
}

/** One resolved Apply-form field: the exact captured POST name, the value to
 * write, and how to write it. `display` (station name) is set on the visible
 * typeahead box alongside the hidden NLC so the user sees the station. */
export interface ApplyField {
  name: string;              // exact form field name (as captured)
  value: string;             // value to write
  kind: 'select' | 'input' | 'station';
  label: string;             // human label for the assist bar / fill note
  display?: string;          // station name to show in the visible typeahead
}

/** Result of resolving a journey → Apply fields: the fields we could fill
 * directly, plus anything we couldn't resolve (station not in the NLC map,
 * unknown mode) so the UI can tell the user exactly what to enter by hand. */
export interface ApplyPlan {
  fields: ApplyField[];
  unresolved: string[];      // labels of fields left for the user
}

const two = (n: number) => (n < 10 ? '0' + n : String(n));
const cleanStation = (name: string) => String(name ?? '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

/** Split "10:32" → { h: "10", m: "32" }; tolerates "9:5" and single parts. */
function splitTime(t: string | undefined): { h: string; m: string } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t ?? '').trim());
  if (!m) return null;
  return { h: String(parseInt(m[1], 10)), m: two(parseInt(m[2], 10)) };
}

/** "2026-07-04" → "04/07/2026" (the DD/MM/YYYY the form posts). */
export const ukDate = (iso: string) => String(iso ?? '').split('-').reverse().join('/');

/**
 * Resolve a journey + eligibility assessment into the exact Apply-form fields.
 * Stations are resolved to NLC via the bundled map; a miss is reported in
 * `unresolved` rather than guessed (a wrong NLC would file a wrong claim).
 */
export function buildApplyPlan(
  journey: ParsedJourney,
  assessment: Assessment | undefined,
  resolveNlcFn: (name: string, modeId: number | null) => number | null = lookupNlc,
): ApplyPlan {
  const fields: ApplyField[] = [];
  const unresolved: string[] = [];

  // Mode
  const lineId = assessment?.disruption?.line ?? assessment?.plausibleLines?.[0];
  const modeId = modeIdForLine(lineId);
  if (modeId != null) {
    fields.push({ name: 'ModeId', value: String(modeId), kind: 'select', label: 'Mode' });
  } else {
    unresolved.push('Mode');
  }

  // Stations → NLC. The claim's ModeId disambiguates interchanges (e.g. Canary
  // Wharf LU vs DLR vs EL). Also carry the display name for the typeahead box.
  const origin = cleanStation(journey.origin);
  const startNlc = resolveNlcFn(origin, modeId);
  if (startNlc != null) {
    fields.push({ name: 'StartNlcId', value: String(startNlc), kind: 'station', label: 'From', display: origin });
  } else if (origin) {
    unresolved.push('From (' + origin + ')');
  }

  const destination = cleanStation(journey.destination ?? '');
  const finishNlc = resolveNlcFn(destination, modeId);
  if (finishNlc != null) {
    fields.push({ name: 'FinishNlcId', value: String(finishNlc), kind: 'station', label: 'To', display: destination });
  } else if (destination) {
    unresolved.push('To (' + destination + ')');
  }

  // Date
  if (journey.date) {
    fields.push({ name: 'JourneyDate', value: ukDate(journey.date), kind: 'input', label: 'Date' });
  }

  // Start time → hours + minutes
  const t = splitTime(journey.tapInTime);
  if (t) {
    fields.push({ name: 'JourneyStartTimeHours', value: t.h, kind: 'select', label: 'Hour' });
    fields.push({ name: 'JourneyStartTimeMins', value: t.m, kind: 'select', label: 'Minute' });
  }

  // Delay length (minutes)
  if (assessment?.overageMinutes != null) {
    fields.push({ name: 'DelayLengthString', value: String(assessment.overageMinutes), kind: 'input', label: 'Delay (min)' });
  }

  return { fields, unresolved };
}

/**
 * The injected direct-fill script. Fills the Apply form by exact field name:
 *
 * - select / input: find [name="…"] and set the value through the native
 *   prototype setter (framework-proof), then fire input + change (and jQuery
 *   change / chosen:updated for enhanced dropdowns). Selects verify the value
 *   maps to a real <option> before claiming success.
 * - station: set the HIDDEN NLC field (StartNlcId/FinishNlcId) directly, and
 *   ALSO set the visible typeahead's text box to the station name so the user
 *   sees it. The visible box is found near the hidden field (same form-group)
 *   or by a station-ish name/placeholder; if none is found the hidden value is
 *   still set (the POST is correct) and the field is reported filled-hidden.
 *
 * Reports {type:'apply-fill', filled, total, results:[{name,filled,via}],
 * schema:[…]} back through ReactNativeWebView.postMessage. `schema` dumps the
 * Apply form's named controls (tag/type, select options, station siblings) so
 * one real tap gives full diagnostics if a widget needs tuning — the script
 * never throws into the page.
 */
export function buildDirectFillScript(fields: ApplyField[]): string {
  const payload = JSON.stringify(fields.map(({ name, value, kind, display }) => ({ name, value, kind, display })));
  return `(function () {
  var report = function (msg) {
    try { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } } catch (e) { }
  };
  try {
    var doc = document;
    var win = window;
    var fields = ${payload};

    var norm = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/\\s+/g, ' ').trim(); };
    var setNativeValue = function (el, value) {
      try {
        var proto = null;
        if (el.tagName === 'SELECT' && win.HTMLSelectElement) proto = win.HTMLSelectElement.prototype;
        else if (el.tagName === 'TEXTAREA' && win.HTMLTextAreaElement) proto = win.HTMLTextAreaElement.prototype;
        else if (win.HTMLInputElement) proto = win.HTMLInputElement.prototype;
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(el, value); return; }
      } catch (e) { }
      try { el.value = value; } catch (e2) { }
    };
    var fire = function (el) {
      try { el.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new win.Event('change', { bubbles: true })); } catch (e) { }
      try { if (win.jQuery) { win.jQuery(el).trigger('change').trigger('chosen:updated').trigger('liszt:updated'); } } catch (e) { }
    };
    var byName = function (name) {
      try { return doc.querySelector('[name="' + name + '"]'); } catch (e) { return null; }
    };
    var selectHasValue = function (el, value) {
      try {
        var opts = el.options || [];
        for (var i = 0; i < opts.length; i++) {
          if (String(opts[i].value) === String(value) || norm(opts[i].textContent) === norm(value)) return opts[i];
        }
      } catch (e) { }
      return null;
    };
    var setSelect = function (el, value) {
      var o = selectHasValue(el, value);
      if (!o) return false;
      setNativeValue(el, o.value);
      try { el.selectedIndex = Array.prototype.indexOf.call(el.options, o); } catch (e) { }
      try { o.selected = true; } catch (e) { }
      fire(el);
      return true;
    };
    var setInput = function (el, value) { setNativeValue(el, value); fire(el); return true; };

    // Find the visible typeahead text box paired with a hidden NLC field: same
    // form-group container, a text input that isn't the hidden one and looks
    // like a station box (name/id/placeholder mentions station/from/to/nlc).
    var findStationBox = function (hidden) {
      try {
        var scope = hidden.closest ? (hidden.closest('.form-group') || hidden.closest('div') || doc) : doc;
        var inputs = scope.querySelectorAll ? scope.querySelectorAll('input') : [];
        var stationish = /station|nlc|origin|destination|from|to|start|finish/i;
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          if (el === hidden) continue;
          var t = (el.type || 'text').toLowerCase();
          if (t === 'hidden' || t === 'submit' || t === 'button') continue;
          var tag = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || '') || '');
          if (stationish.test(tag)) return el;
        }
        // Fallback: the first visible text input in the group.
        for (var j = 0; j < inputs.length; j++) {
          var e2 = inputs[j];
          if (e2 === hidden) continue;
          if ((e2.type || 'text').toLowerCase() === 'text') return e2;
        }
      } catch (e) { }
      return null;
    };

    var results = [];
    var filled = 0;
    for (var f = 0; f < fields.length; f++) {
      var fld = fields[f];
      var entry = { name: fld.name, filled: false, via: null };
      try {
        var el = byName(fld.name);
        if (!el) { entry.via = 'not-found'; results.push(entry); continue; }
        if (fld.kind === 'station') {
          // Set the hidden NLC directly (this is what the POST sends).
          setInput(el, fld.value);
          entry.filled = true; entry.via = 'nlc-hidden';
          // Show the station name in the visible typeahead if we can find it.
          if (fld.display) {
            var box = findStationBox(el);
            if (box) { setInput(box, fld.display); entry.via = 'nlc+display'; }
          }
        } else if (el.tagName === 'SELECT') {
          if (setSelect(el, fld.value)) { entry.filled = true; entry.via = 'select'; }
          else { entry.via = 'no-option'; }
        } else {
          setInput(el, fld.value);
          entry.filled = true; entry.via = el.tagName === 'TEXTAREA' ? 'textarea' : 'input';
        }
      } catch (err) { entry.via = 'error:' + String(err); }
      if (entry.filled) filled++;
      results.push(entry);
    }

    // Diagnostic schema dump of the Apply form's named controls — so one real
    // tap reveals the true widget shapes if any field didn't take.
    var schema = [];
    try {
      var host = null;
      var startEl = byName('StartNlcId');
      if (startEl && startEl.closest) host = startEl.closest('form');
      if (!host) host = doc.querySelector('form[action*="ServiceDelayRefunds"]') || doc;
      var controls = host.querySelectorAll ? host.querySelectorAll('input[name], select[name], textarea[name]') : [];
      for (var c = 0; c < controls.length && c < 60; c++) {
        var ce = controls[c];
        var row = { name: ce.name, tag: ce.tagName, type: (ce.type || '').toLowerCase(), id: ce.id || '' };
        if (ce.tagName === 'SELECT' && ce.options) {
          var opts = [];
          for (var o2 = 0; o2 < ce.options.length && o2 < 30; o2++) { opts.push({ v: ce.options[o2].value, t: norm(ce.options[o2].textContent).slice(0, 24) }); }
          row.options = opts;
        }
        schema.push(row);
      }
    } catch (e) { }

    report({ type: 'apply-fill', filled: filled, total: fields.length, results: results, schema: schema });
  } catch (e) {
    report({ type: 'apply-fill', error: String(e) });
  }
})(); true;`;
}
