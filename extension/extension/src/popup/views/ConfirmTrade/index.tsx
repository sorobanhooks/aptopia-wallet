import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { Button, Heading, Icon, Loader, Text } from "@stellar/design-system";

import { View } from "popup/basics/layout/View";
import { SubviewHeader } from "popup/components/SubviewHeader";
import { agentBackendService } from "api/agentBackendService";
import {
  publicKeySelector,
  agentAddressSelector,
  setAgentAddress,
} from "popup/ducks/accountServices";
import { PendingTier2Trade } from "api/types";

import "./styles.scss";

const POLL_INTERVAL_MS = 15_000;

/** Returns a human-readable relative age string, e.g. "2 min ago". Handles null gracefully. */
function formatAge(createdAt: string | null): string {
  if (!createdAt) {
    return "—";
  }
  const diffMs = Date.now() - new Date(createdAt).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return "—";
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

export const ConfirmTrade = () => {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const publicKey = useSelector(publicKeySelector);
  const reduxAgentAddress = useSelector(agentAddressSelector);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const [trades, setTrades] = useState<PendingTier2Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastConfirmedTxHash, setLastConfirmedTxHash] = useState<string | null>(
    null,
  );

  const fetchPending = useCallback(async () => {
    if (!publicKey) return;

    // Authenticate /v1/* calls as the active wallet (SIWE-style).
    agentBackendService.setSigningKey(publicKey);

    try {
      let agentAddress = reduxAgentAddress;

      if (!agentAddress) {
        const metricsData = await agentBackendService.getMetrics(publicKey);
        agentAddress = metricsData.agentAddress;
        dispatch(setAgentAddress(agentAddress));
      }

      const data = await agentBackendService.getPendingTier2(agentAddress);
      if (isMounted.current) setTrades(data);
    } catch (e) {
      console.error("Failed to fetch pending tier-2 trades:", e);
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  }, [publicKey, reduxAgentAddress, dispatch]);

  // Initial fetch
  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  // Poll every 15 seconds
  useEffect(() => {
    const id = setInterval(() => {
      fetchPending();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchPending]);

  // Refetch on window focus
  useEffect(() => {
    const handleFocus = () => {
      fetchPending();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [fetchPending]);

  const handleConfirm = async (trade: PendingTier2Trade) => {
    const agentAddress = reduxAgentAddress;
    if (!agentAddress) return;
    setActionInProgress(trade.id);
    setActionError(null);
    setLastConfirmedTxHash(null);
    // Map the displayed side to the wire direction expected by the backend.
    const direction: "buy_xlm" | "sell_xlm" =
      trade.side === "buy" ? "buy_xlm" : "sell_xlm";
    try {
      const result = await agentBackendService.confirmTier2(
        agentAddress,
        trade.id,
        direction,
      );
      if (isMounted.current) setLastConfirmedTxHash(result.txHash);
      // Refetch to clear the confirmed trade from the list
      await fetchPending();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMounted.current) setActionError(msg);
    } finally {
      if (isMounted.current) setActionInProgress(null);
    }
  };

  const handleReject = async (trade: PendingTier2Trade) => {
    const agentAddress = reduxAgentAddress;
    if (!agentAddress) return;
    setActionInProgress(trade.id);
    setActionError(null);
    try {
      await agentBackendService.rejectTier2(agentAddress, trade.id);
      // Refetch to clear the rejected trade from the list
      await fetchPending();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMounted.current) setActionError(msg);
    } finally {
      if (isMounted.current) setActionInProgress(null);
    }
  };

  return (
    <React.Fragment>
      <SubviewHeader title={t("Confirm Trade")} />
      <View.Content hasNoTopPadding>
        <div className="ConfirmTrade">
          {lastConfirmedTxHash && (
            <div className="ConfirmTrade__success">
              <Icon.CheckCircle />
              <Text as="p" size="sm">
                {t("Trade confirmed.")}
              </Text>
              <Text
                as="p"
                size="xs"
                addlClassName="ConfirmTrade__success__hash"
              >
                {lastConfirmedTxHash}
              </Text>
            </div>
          )}

          {actionError && (
            <div className="ConfirmTrade__error">
              <Icon.AlertCircle />
              <Text as="p" size="sm">
                {actionError}
              </Text>
            </div>
          )}

          {isLoading ? (
            <div className="ConfirmTrade__loading">
              <Loader />
            </div>
          ) : trades.length === 0 ? (
            <div className="ConfirmTrade__empty">
              <Icon.CheckCircle />
              <Heading as="h2" size="xs">
                {t("No pending trades")}
              </Heading>
              <Text as="p" size="sm">
                {t(
                  "When your agent proposes a Tier-2 trade it will appear here for your approval.",
                )}
              </Text>
            </div>
          ) : (
            <div className="ConfirmTrade__list">
              {trades.map((trade) => {
                const isBusy = actionInProgress === trade.id;
                return (
                  <div key={trade.id} className="ConfirmTrade__item">
                    <div className="ConfirmTrade__item__header">
                      <span
                        className={`ConfirmTrade__item__side ConfirmTrade__item__side--${trade.side}`}
                      >
                        {trade.side === "buy" ? t("BUY") : t("SELL")}
                      </span>
                      <span className="ConfirmTrade__item__age">
                        {formatAge(trade.createdAt)}
                      </span>
                    </div>

                    <div className="ConfirmTrade__item__body">
                      <div className="ConfirmTrade__item__row">
                        <span className="ConfirmTrade__item__label">
                          {t("Token")}
                        </span>
                        <span className="ConfirmTrade__item__value">
                          {trade.token}
                        </span>
                      </div>
                      <div className="ConfirmTrade__item__row">
                        <span className="ConfirmTrade__item__label">
                          {t("Amount")}
                        </span>
                        <span className="ConfirmTrade__item__value">
                          {trade.amount}
                        </span>
                      </div>
                      {trade.plannedUsdc && (
                        <div className="ConfirmTrade__item__row">
                          <span className="ConfirmTrade__item__label">
                            {t("Planned USDC")}
                          </span>
                          <span className="ConfirmTrade__item__value">
                            {trade.plannedUsdc} USDC
                          </span>
                        </div>
                      )}
                      {trade.plannedXlm && (
                        <div className="ConfirmTrade__item__row">
                          <span className="ConfirmTrade__item__label">
                            {t("Planned XLM")}
                          </span>
                          <span className="ConfirmTrade__item__value">
                            {trade.plannedXlm} XLM
                          </span>
                        </div>
                      )}
                      {trade.price && (
                        <div className="ConfirmTrade__item__row">
                          <span className="ConfirmTrade__item__label">
                            {t("Price")}
                          </span>
                          <span className="ConfirmTrade__item__value">
                            {trade.price}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="ConfirmTrade__item__actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        isFullWidth
                        isLoading={isBusy}
                        disabled={!!actionInProgress}
                        onClick={() => handleReject(trade)}
                      >
                        {t("Reject")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        isFullWidth
                        isLoading={isBusy}
                        disabled={!!actionInProgress}
                        onClick={() => handleConfirm(trade)}
                      >
                        {t("Confirm")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </View.Content>
    </React.Fragment>
  );
};
