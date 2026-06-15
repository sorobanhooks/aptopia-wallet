import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { Heading, Icon, Loader, Text } from "@stellar/design-system";

import { View } from "popup/basics/layout/View";
import { SubviewHeader } from "popup/components/SubviewHeader";
import { agentBackendService } from "api/agentBackendService";
import {
  publicKeySelector,
  agentAddressSelector,
  setAgentAddress,
} from "popup/ducks/accountServices";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { AgentLog } from "api/types";
import { truncatedPublicKey, getExplorerUrl } from "helpers/stellar";

import "./styles.scss";

const ITEMS_PER_PAGE = 10;

// ---------------------------------------------------------------------------
// ActivityLogRow — lazy narration fetch via IntersectionObserver
// ---------------------------------------------------------------------------

interface ActivityLogRowProps {
  log: AgentLog;
  address: string;
  networkDetails: ReturnType<typeof settingsNetworkDetailsSelector>;
  isLast: boolean;
  lastRef: (node: HTMLDivElement) => void;
}

function ActivityLogRow({
  log,
  address,
  networkDetails,
  isLast,
  lastRef,
}: ActivityLogRowProps) {
  const { t } = useTranslation();
  const [narration, setNarration] = useState<string | null>(
    log.narration ?? null,
  );
  const [isNarrationLoading, setIsNarrationLoading] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const narrationFetched = useRef(false);

  // Assign both refs when the last-row sentinel is also this row
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      rowRef.current = node;
      if (isLast && node) {
        lastRef(node);
      }
    },
    [isLast, lastRef],
  );

  useEffect(() => {
    // Reset the guard whenever log._id changes (row reuse / pagination).
    narrationFetched.current = false;
    // If narration already available (e.g. from cached server response), skip fetch
    if (narration !== null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !narrationFetched.current) {
          narrationFetched.current = true;
          setIsNarrationLoading(true);
          agentBackendService
            .narrateLog(address, log._id)
            .then((res) => {
              setNarration(res.narration);
            })
            .catch((err) => {
              console.error("[ActivityLog] narrateLog failed:", err);
              // Silently swallow — narration is decorative, not critical
            })
            .finally(() => {
              setIsNarrationLoading(false);
            });
        }
      },
      { threshold: 0.1 },
    );

    if (rowRef.current) {
      observer.observe(rowRef.current);
    }

    return () => observer.disconnect();
  }, [address, log._id, narration]);

  return (
    <div key={log._id} className="ActivityLog__item" ref={setRef}>
      <div className="ActivityLog__item__content">
        <div className="ActivityLog__item__row">
          <span className="ActivityLog__item__title">{log.amount}</span>
          <span
            className={`ActivityLog__item__status ActivityLog__item__status--${log.status}`}
          >
            {log.status === "failure" ? t("Failed") : t("Success")}
          </span>
        </div>
        <div className="ActivityLog__item__details">
          {log.reason && (
            <span className="ActivityLog__item__info">{log.reason}</span>
          )}
        </div>
        {/* AI narration — lazy-loaded, read-only */}
        {isNarrationLoading ? (
          <div
            className="ActivityLog__item__narration ActivityLog__item__narration--shimmer"
            aria-busy="true"
          />
        ) : narration ? (
          <div className="ActivityLog__item__narration">{narration}</div>
        ) : null}
        <div className="ActivityLog__item__footer">
          <span className="ActivityLog__item__date">
            {new Date(log.createdAt).toLocaleString()}
          </span>
          <a
            href={getExplorerUrl(log.txHash, networkDetails)}
            target="_blank"
            rel="noopener noreferrer"
            className="ActivityLog__item__link"
          >
            {truncatedPublicKey(log.txHash)}
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityLog view
// ---------------------------------------------------------------------------

export const ActivityLog = () => {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const publicKey = useSelector(publicKeySelector);
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const reduxAgentAddress = useSelector(agentAddressSelector);

  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [agentAddress, setLocalAgentAddress] = useState<string | null>(
    reduxAgentAddress,
  );

  const observer = useRef<IntersectionObserver | null>(null);
  const lastElementRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoading || isFetchingMore) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setPage((prevPage) => prevPage + 1);
        }
      });

      if (node) observer.current.observe(node);
    },
    [isLoading, isFetchingMore, hasMore],
  );

  const fetchLogs = useCallback(async () => {
    if (!publicKey || !hasMore) return;

    // Authenticate /v1/* calls as the active wallet (SIWE-style).
    agentBackendService.setSigningKey(publicKey);

    if (page === 1) {
      setIsLoading(true);
    } else {
      setIsFetchingMore(true);
    }

    try {
      let resolvedAgentAddress = agentAddress ?? reduxAgentAddress;

      if (!resolvedAgentAddress) {
        const metricsData = await agentBackendService.getMetrics(publicKey);
        resolvedAgentAddress = metricsData.agentAddress;
        setLocalAgentAddress(resolvedAgentAddress);
        dispatch(setAgentAddress(resolvedAgentAddress));
      }

      const data = await agentBackendService.getLogs(
        resolvedAgentAddress,
        page,
        ITEMS_PER_PAGE,
      );

      setLogs((prev) => {
        // Prevent duplicates if useEffect triggers twice in dev mode
        const existingIds = new Set(prev.map((l) => l._id));
        const newItems = data.items.filter((l) => !existingIds.has(l._id));
        return [...prev, ...newItems];
      });

      setHasMore(logs.length + data.items.length < data.total);
    } catch (e) {
      console.error("Failed to fetch logs:", e);
    } finally {
      setIsLoading(false);
      setIsFetchingMore(false);
    }
  }, [
    publicKey,
    reduxAgentAddress,
    agentAddress,
    page,
    dispatch,
    hasMore,
    logs.length,
  ]);

  useEffect(() => {
    fetchLogs();
  }, [page]); // Only trigger fetch when page changes (including initial load)

  return (
    <React.Fragment>
      <SubviewHeader title={t("Activity Log")} />
      <View.Content hasNoTopPadding>
        <div className="ActivityLog">
          {isLoading && page === 1 ? (
            <div className="ActivityLog__loading">
              <Loader />
            </div>
          ) : logs.length === 0 ? (
            <div className="ActivityLog__empty">
              <Icon.Activity />
              <Heading as="h2" size="xs">
                {t("No activity yet")}
              </Heading>
              <Text as="p" size="sm">
                {t(
                  "Transactions and agent actions will appear here once they occur.",
                )}
              </Text>
            </div>
          ) : (
            <div className="ActivityLog__list">
              {logs.map((log, index) => (
                <ActivityLogRow
                  key={log._id}
                  log={log}
                  address={agentAddress ?? reduxAgentAddress ?? ""}
                  networkDetails={networkDetails}
                  isLast={index === logs.length - 1}
                  lastRef={lastElementRef}
                />
              ))}

              {isFetchingMore && (
                <div className="ActivityLog__fetching-more">
                  <Loader />
                </div>
              )}
            </div>
          )}
        </div>
      </View.Content>
    </React.Fragment>
  );
};
