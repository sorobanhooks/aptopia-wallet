/** The four v1 strategy types. */
export type StrategyType = 'dca' | 'dip_buy' | 'take_profit' | 'stop_loss';

/** Slot a strategy occupies. Exactly one ENABLED `accumulate` is allowed per agent. */
export type StrategyRole = 'accumulate' | 'sell' | 'protect';

/**
 * A single configured strategy, as read from the Agent document.
 * `id` is the Mongo subdocument _id as a string (used for callback_data + REST).
 * `params` holds type-specific numbers (see STRATEGY_DEFAULTS for shapes).
 */
export interface StrategyConfig {
  id: string;
  type: StrategyType;
  role: StrategyRole;
  enabled: boolean;
  params: Record<string, number>;
  lastRunAt: Date | null;
}

/** Shape used when CREATING a strategy (Mongo assigns the _id, lastRunAt starts null). */
export interface NewStrategyInput {
  type: StrategyType;
  role: StrategyRole;
  enabled: boolean;
  params: Record<string, number>;
  lastRunAt: null;
}

/** Higher number wins when multiple strategies fire on the same tick. */
export const ROLE_PRIORITY: Record<StrategyRole, number> = {
  protect: 3,
  sell: 2,
  accumulate: 1,
};

/** Canonical role + default params per type. Used by the API, presets, and migration. */
export const STRATEGY_DEFAULTS: Record<
  StrategyType,
  { role: StrategyRole; params: Record<string, number> }
> = {
  dca: { role: 'accumulate', params: { intervalMin: 1440, amountUsdc: 1 } },
  dip_buy: { role: 'accumulate', params: { buyBelowUsd: 0.1, amountUsdc: 1 } },
  take_profit: { role: 'sell', params: { sellAboveUsd: 0.5, sellAmountXlm: 1 } },
  stop_loss: { role: 'protect', params: { sellBelowUsd: 0.08, sellAmountXlm: 1 } },
};

/** Quick-pick intervals offered in the UI (Plan 2). `2` is the live-demo option. */
export const DCA_INTERVAL_PRESETS_MIN: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '2 min (demo)', minutes: 2 },
  { label: 'Hourly', minutes: 60 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
];
