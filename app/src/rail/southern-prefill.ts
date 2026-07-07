// Southern Railway / GTR — Delay Repay claim prefill.
//
// Southern, Thameslink, Great Northern and Gatwick Express are all part of
// the GTR franchise. Each brand has its own portal but they share the same
// underlying Passenger Assist / Delay Repay 15 system.
//
// Portal URLs:
//   Southern:           https://www.southernrailway.com/help/delay-repay
//   Thameslink/GN:      https://www.thameslinkrailway.com/help/delay-repay
//   Gatwick Express:    https://www.gatwickexpress.com/help/delay-repay
//
// NR-1 scope: Southern as the primary (most relevant for Luke's commute).
// GTR_CLAIM_URL is exported separately for GN/Thameslink access.

import type { PrefillField } from '../claims/prefill.ts';
import { bandFor, bandLabel } from './eligibility.ts';
import type { RailJourney } from './store-core.ts';
import { stationByCrs } from './stations.ts';

export const SOUTHERN_CLAIM_URL =
  'https://www.southernrailway.com/help/delay-repay';

export const GTR_CLAIM_URL =
  'https://www.thameslinkrailway.com/help/delay-repay';

function stationName(crs: string): string {
  return stationByCrs(crs)?.name ?? crs;
}

const ukDate = (iso: string) => iso.split('-').reverse().join('/');

export function buildSouthernPrefill(
  journey: RailJourney,
  delayMinutes: number | null,
): PrefillField[] {
  const fields: PrefillField[] = [
    {
      key: 'date',
      label: 'Date',
      value: ukDate(journey.departureDate),
      keywords: ['date of travel', 'travel date', 'date'],
    },
    {
      key: 'from',
      label: 'From',
      value: stationName(journey.originCrs),
      keywords: ['from station', 'origin station', 'departure', 'from', 'boarded'],
    },
    {
      key: 'to',
      label: 'To',
      value: stationName(journey.destinationCrs),
      keywords: ['to station', 'destination station', 'arrival', 'to', 'alighted'],
    },
    {
      key: 'departTime',
      label: 'Depart',
      value: journey.scheduledDepart,
      keywords: ['departure time', 'scheduled departure', 'planned', 'depart'],
    },
  ];

  if (journey.scheduledArrive) {
    fields.push({
      key: 'arriveTime',
      label: 'Arrive (sched)',
      value: journey.scheduledArrive,
      keywords: ['scheduled arrival', 'planned arrival', 'due'],
    });
  }
  if (journey.actualArrive) {
    fields.push({
      key: 'actualArrive',
      label: 'Actual arrival',
      value: journey.actualArrive,
      keywords: ['actual arrival', 'arrived at', 'actual time arrived'],
    });
  }
  if (delayMinutes != null) {
    fields.push({
      key: 'delay',
      label: 'Delay (min)',
      value: String(delayMinutes),
      keywords: ['delay', 'minutes late', 'delayed by', 'length of delay'],
    });
    const band = bandFor(delayMinutes);
    if (band !== 'none') {
      fields.push({
        key: 'band',
        label: 'Delay band',
        value: bandLabel(band),
        keywords: ['compensation type', 'delay band', 'claim type'],
      });
    }
  }
  if (journey.singleFare != null) {
    fields.push({
      key: 'fare',
      label: 'Fare (£)',
      value: journey.singleFare.toFixed(2),
      keywords: ['ticket price', 'cost of ticket', 'fare paid'],
    });
  }

  return fields.filter(f => f.value !== '');
}

/**
 * Inject-friendly ES5 fill script for the Southern/GTR Delay Repay portal.
 * Mirrors the Avanti script — same DOM strategy, same postMessage protocol.
 */
export function buildSouthernFillScript(fields: PrefillField[]): string {
  const payload = JSON.stringify(
    fields.map(({ key, value, keywords }) => ({ key, value, keywords })),
  );
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var fields = ${payload};
    var norm = function (s) {
      return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    var haystack = function (el) {
      var parts = [el.id, el.name, el.placeholder, el.getAttribute && el.getAttribute('aria-label')];
      try {
        if (el.id) { var lab = doc.querySelector('label[for="' + el.id + '"]'); if (lab) parts.push(lab.textContent); }
        var wrap = el.closest ? el.closest('label') : null; if (wrap) parts.push(wrap.textContent);
      } catch (e) { }
      return norm(parts.filter(Boolean).join(' '));
    };
    var setVal = function (el, v) {
      try {
        var p = el.tagName === 'SELECT' ? window.HTMLSelectElement && window.HTMLSelectElement.prototype
          : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement && window.HTMLInputElement.prototype;
        var d = p && Object.getOwnPropertyDescriptor(p, 'value');
        if (d && d.set) { d.set.call(el, v); return; }
      } catch (e) { }
      el.value = v;
    };
    var fire = function (el) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { }
    };
    var all = [];
    try { var ns = doc.querySelectorAll('input,select,textarea'); for (var i = 0; i < ns.length; i++) all.push(ns[i]); } catch (e) { }
    var results = []; var filled = 0;
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var entry = { key: field.key, filled: false, via: null };
      try {
        for (var e2 = 0; e2 < all.length; e2++) {
          var el = all[e2];
          var t = (el.type || '').toLowerCase();
          if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'password' || t === 'file') continue;
          var h = haystack(el);
          if (!h) continue;
          var hit = false;
          for (var k = 0; k < field.keywords.length; k++) { if (h.indexOf(field.keywords[k]) !== -1) { hit = true; break; } }
          if (!hit) continue;
          var v = field.value;
          var dm = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(v);
          if (el.type === 'date' && dm) v = dm[3] + '-' + dm[2] + '-' + dm[1];
          setVal(el, v); fire(el);
          entry.filled = true; entry.via = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'input';
          break;
        }
      } catch (err) { entry.note = String(err); }
      if (entry.filled) filled++;
      results.push(entry);
    }
    report({ type: 'prefill', filled: filled, total: fields.length, results: results });
  } catch (e) {
    report({ type: 'prefill', error: String(e) });
  }
})(); true;`;
}
