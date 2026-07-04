// Orchestrator: resolve CSV station names → planner timing → engine verdict.
// Deps are injected; the TfL-5 UI supplies real fetch/cache/ledger adapters.
import { estimateFare } from '../data';
import { ParsedJourney } from '../journeys/parse';
import { Assessment, DisruptionLookup, assessJourney } from './engine';
import { FetchJson, TimingCache, expectedTiming } from './planner';
import { resolveStation } from './resolve';

export interface AssessDeps {
  fetchJson: FetchJson;
  cache?: TimingCache;
  appKey?: string;
  lookup: DisruptionLookup;
}

export async function assessParsedJourney(journey: ParsedJourney, deps: AssessDeps): Promise<Assessment> {
  if (journey.incomplete || !journey.destination) {
    return assessJourney({ journey, timing: null, lookup: deps.lookup });
  }
  const from = resolveStation(journey.origin);
  const to = resolveStation(journey.destination);
  if (!from || !to) {
    return {
      status: 'not-assessable',
      reasonCode: 'unresolved-station',
      refundValue: journey.charge,
      plausibleLines: [],
    };
  }
  const timing = await expectedTiming(from.id, to.id, deps);
  return assessJourney({
    journey,
    timing,
    lookup: deps.lookup,
    fareEstimate: estimateFare(from.id, to.id),
  });
}
