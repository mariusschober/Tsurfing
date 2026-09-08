import { validateCounterBaseline, type CounterBaseline } from '../src/domain/counterLedger';
import { assertCausalCutoverReceipt, parseCausalCutover } from './causalCutoverProtocol';
import { stableJson } from './syncProtocol';

export interface BaselineBinding {
  schemaVersion: 1;
  original: CounterBaseline;
  canonical: CounterBaseline;
  cutoverRequest: string;
  cutoverReceipt: Record<string, any>;
}
type BindingState = {
  counterBaselineBindings?: Record<string, BaselineBinding>;
  counterBaselines?: Record<string, CounterBaseline>;
  counterEvents?: Record<string, unknown>;
  cutoverRequest?: string;
  cutoverReceipt?: Record<string, any>;
  cutover: { trackingPresent: boolean; trackingValue: unknown };
};
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** The original baseline remains audit and anti-replay evidence. The canonical
 * baseline remains byte/semantic-exact server evidence; neither is rewritten. */
export function validateBaselineBindings(accountId: string, state: BindingState) {
  const bindings = state.counterBaselineBindings;
  if (bindings === undefined) return;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('Invalid baseline binding journal.');
  for (const [day, binding] of Object.entries(bindings)) {
    if (!binding || binding.schemaVersion !== 1 || typeof binding.cutoverRequest !== 'string') throw new Error('Invalid baseline binding.');
    validateCounterBaseline(binding.original);
    validateCounterBaseline(binding.canonical);
    const operation = parseCausalCutover(accountId, JSON.parse(binding.cutoverRequest));
    const receipt = assertCausalCutoverReceipt(accountId, operation, binding.cutoverReceipt);
    const payload = operation.expectedTrackingPayload;
    if (binding.cutoverRequest !== state.cutoverRequest || !same(binding.cutoverReceipt, state.cutoverReceipt)
      || !state.cutover.trackingPresent || !same(payload, state.cutover.trackingValue)
      || binding.original.accountId !== accountId || binding.original.day !== day || payload.date !== day
      || !same(binding.original.counts, { planViewCount: payload.planViewCount, dailyPostponeCount: payload.dailyPostponeCount })
      || !same(binding.canonical, receipt.baseline) || !same(state.counterBaselines?.[day], binding.canonical)) {
      throw new Error('The baseline binding differs from preserved enrollment evidence.');
    }
    for (const id of [binding.original.baselineId, ...binding.original.evidenceIds]) {
      if (Object.hasOwn(state.counterEvents ?? {}, id)) throw new Error('Historical baseline evidence cannot become a new delta.');
    }
  }
}

export function bindCanonicalBaseline(accountId: string, state: BindingState, canonical: CounterBaseline) {
  const original = state.counterBaselines?.[canonical.day];
  if (!original || same(original, canonical)) return;
  if (state.counterBaselineBindings?.[canonical.day] || !state.cutoverRequest || !state.cutoverReceipt) {
    throw new Error('The local baseline needs explicit recovery; it was not replaced.');
  }
  state.counterBaselineBindings ??= {};
  state.counterBaselineBindings[canonical.day] = { schemaVersion: 1, original: structuredClone(original),
    canonical: structuredClone(canonical), cutoverRequest: state.cutoverRequest, cutoverReceipt: structuredClone(state.cutoverReceipt) };
  state.counterBaselines![canonical.day] = canonical;
  validateBaselineBindings(accountId, state);
}
