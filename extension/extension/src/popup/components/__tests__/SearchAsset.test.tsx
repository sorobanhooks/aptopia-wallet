import React from "react";
import { render, waitFor, screen, fireEvent } from "@testing-library/react";

import * as ApiInternal from "@shared/api/internal";

import { SearchAsset } from "popup/components/manageAssets/SearchAsset";
import {
  mockAccounts,
  mockBalances,
  TEST_CANONICAL,
  Wrapper,
} from "popup/__testHelpers__";
import { ROUTES } from "popup/constants/routes";
import {
  DEFAULT_NETWORKS,
  MAINNET_NETWORK_DETAILS,
  NETWORKS,
} from "@shared/constants/stellar";
import { APPLICATION_STATE as ApplicationState } from "@shared/constants/applicationState";

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useLocation: jest.fn(),
}));

// useGetBalances now loads balances via stellar-sdk's Horizon.Server and serves
// cache hits from `cache.formattedBalanceData[network][publicKey]` verbatim. The
// component fetches with useCache=true, so seeding this slice short-circuits the
// network round-trip and lets the component render real data instead of hanging
// on the loading spinner. The payload's `balances` must be the formatted ARRAY
// that ManageAssetRows/findAssetBalance iterate over.
const cachedBalancesPayload = {
  balances: [
    (mockBalances.balances as Record<string, any>).native,
    (mockBalances.balances as Record<string, any>)[TEST_CANONICAL],
    (mockBalances.balances as Record<string, any>)[
      "USDC:GCK3D3V2XNLLKRFGFFFDEJXA4O2J4X36HET2FE446AV3M4U7DPHO3PEM"
    ],
  ],
  tokenPrices: {},
  publicKey: "G1",
  isFunded: true,
  isUnfunded: false,
  subentryCount: 1,
  icons: {},
};

const seededCache = {
  formattedBalanceData: {
    [NETWORKS.PUBLIC]: {
      G1: cachedBalancesPayload,
    },
  },
};

describe("SearchAsset", () => {
  jest
    .spyOn(ApiInternal, "getAccountBalances")
    .mockImplementation(() => Promise.resolve(mockBalances));

  it("should render", async () => {
    render(
      <Wrapper
        routes={[ROUTES.searchAsset]}
        state={{
          auth: {
            error: null,
            applicationState: ApplicationState.MNEMONIC_PHRASE_CONFIRMED,
            publicKey: "G1",
            allAccounts: mockAccounts,
          },
          settings: {
            networkDetails: MAINNET_NETWORK_DETAILS,
            networksList: DEFAULT_NETWORKS,
          },
          cache: seededCache,
        }}
      >
        <SearchAsset />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("AppHeaderPageTitle")).toHaveTextContent(
        "Choose asset",
      );
    });
  });
  it("should cancel the request when search is changed", async () => {
    const signalMock = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      aborted: false,
    };
    const abortMock = jest.fn();
    const mockAbortController = jest.fn(() => ({
      abort: abortMock,
      signal: signalMock,
    }));

    jest
      .spyOn(global, "AbortController")
      .mockImplementation(() => mockAbortController() as any);

    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((url) => {
      return new Promise((resolve) => {
        if (
          url === "https://api.stellar.expert/explorer/public/asset?search=USDC"
        ) {
          return resolve({
            ok: true,
            json: async () => ({
              _embedded: {
                records: [
                  {
                    asset:
                      "USDC-GCK3D3V2XNLLKRFGFFFDEJXA4O2J4X36HET2FE446AV3M4U7DPHO3PEM",
                  },
                ],
              },
            }),
          } as any);
        }
        if (
          url === "https://api.stellar.expert/explorer/public/asset?search=XLM"
        ) {
          return resolve({
            ok: true,
            json: async () => ({
              _embedded: {
                records: [
                  {
                    asset:
                      "XLM-GCK3D3V2XNLLKRFGFFFDEJXA4O2J4X36HET2FE446AV3M4U7DPHO3PEM",
                  },
                ],
              },
            }),
          } as any);
        }
      });
    });

    render(
      <Wrapper
        routes={[ROUTES.searchAsset]}
        state={{
          auth: {
            error: null,
            applicationState: ApplicationState.MNEMONIC_PHRASE_CONFIRMED,
            publicKey: "G1",
            allAccounts: mockAccounts,
            balances: mockBalances,
          },
          settings: {
            networkDetails: MAINNET_NETWORK_DETAILS,
            networksList: DEFAULT_NETWORKS,
            assetsLists: {
              [NETWORKS.PUBLIC]: [],
            },
          },
          cache: seededCache,
        }}
      >
        <SearchAsset />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("AppHeaderPageTitle")).toHaveTextContent(
        "Choose asset",
      );
    });

    fireEvent.change(screen.getByTestId("search-asset-input"), {
      target: { value: "USDC" },
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.stellar.expert/explorer/public/asset?search=USDC",
        {
          signal: signalMock,
        },
      );
    });
    expect(abortMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("search-asset-input"), {
      target: { value: "XLM" },
    });

    await waitFor(() => {
      // the 2nd request for XLM should cancel the 1st request for a Blockaid scan of USDC
      expect(abortMock).toHaveBeenCalledTimes(1);
      // expect 4 calls because we make 2 calls to stellar.expert and 2 calls to blockaid
      expect(fetchSpy).toHaveBeenCalledTimes(4);

      // check that we only have results for our last search
      expect(screen.getByTestId("ManageAssetCode")).not.toHaveTextContent(
        "USDC",
      );
      expect(screen.getByTestId("ManageAssetCode")).toHaveTextContent("XLM");
    });
  });
});
