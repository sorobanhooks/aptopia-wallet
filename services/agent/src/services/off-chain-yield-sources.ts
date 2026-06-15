/**
 * Off-chain yield sources — hand-curated list.
 *
 * This list is NOT live-scraped. Rates are manually reviewed and updated
 * by the Aptopia team when providers publish new figures.
 *
 * Refresh cadence: review monthly or whenever a provider announces a rate
 * change. To update: edit the `apyPercent` field and the `asOf` field below,
 * then redeploy.
 *
 * Rationale for a static list: off-chain custodial providers (Wirex, Ultra
 * Stellar) do not expose a public API for their live savings rates. Scraping
 * their marketing pages would be fragile and legally ambiguous. A hand-curated
 * list is transparent, auditable, and clearly labelled as provider self-reported
 * data — matching the disclaimer shown in the UI.
 */

export interface OffChainYieldSource {
  id: string;
  /** Human-readable provider name shown in UI. */
  name: string;
  /** Primary asset this rate applies to. */
  asset: string;
  /** Annual percentage yield as a number (e.g. 6.0 = 6%). */
  apyPercent: number;
  /** Provider's product/savings page URL — opened in new tab from the UI. */
  url: string;
  /** ISO date string when this rate was last manually verified. */
  asOf: string;
}

/**
 * Hand-curated off-chain yield sources displayed in YieldHub.
 *
 * Last reviewed: 2025-05-01
 * Sources:
 *  - Wirex: https://wirexapp.com/en/cryptoback — "Up to 6% APY on USDC"
 *  - Ultra Stellar: https://ultrastellar.com/ — "~5% APY on USDC savings"
 */
export const OFF_CHAIN_YIELD_SOURCES: OffChainYieldSource[] = [
  {
    id: "wirex-usdc",
    name: "Wirex",
    asset: "USDC",
    apyPercent: 6.0,
    url: "https://wirexapp.com/en/cryptoback",
    asOf: "2025-05-01",
  },
  {
    id: "ultrastellar-usdc",
    name: "Ultra Stellar",
    asset: "USDC",
    apyPercent: 5.0,
    url: "https://ultrastellar.com/",
    asOf: "2025-05-01",
  },
];
