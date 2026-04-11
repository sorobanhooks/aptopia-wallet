import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSelector, useDispatch } from "react-redux";
import { Heading, Icon, Loader, Text } from "@stellar/design-system";

import { View } from "popup/basics/layout/View";
import { SubviewHeader } from "popup/components/SubviewHeader";
import { agentBackendService } from "api/agentBackendService";
import { publicKeySelector, agentAddressSelector, setAgentAddress } from "popup/ducks/accountServices";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { AgentLog } from "api/types";
import { truncatedPublicKey, getExplorerUrl } from "helpers/stellar";

import "./styles.scss";

const ITEMS_PER_PAGE = 10;

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

    if (page === 1) {
      setIsLoading(true);
    } else {
      setIsFetchingMore(true);
    }

    try {
      let agentAddress = reduxAgentAddress;

      if (!agentAddress) {
        const metricsData = await agentBackendService.getMetrics(publicKey);
        agentAddress = metricsData.agentAddress;
        dispatch(setAgentAddress(agentAddress));
      }

      const data = await agentBackendService.getLogs(agentAddress, page, ITEMS_PER_PAGE);
      
      setLogs((prev) => {
        // Prevent duplicates if useEffect triggers twice in dev mode
        const existingIds = new Set(prev.map(l => l._id));
        const newItems = data.items.filter(l => !existingIds.has(l._id));
        return [...prev, ...newItems];
      });

      setHasMore(logs.length + data.items.length < data.total);
    } catch (e) {
      console.error("Failed to fetch logs:", e);
    } finally {
      setIsLoading(false);
      setIsFetchingMore(false);
    }
  }, [publicKey, reduxAgentAddress, page, dispatch, hasMore, logs.length]);

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
              <Heading as="h2" size="xs">{t("No activity yet")}</Heading>
              <Text as="p" size="sm">{t("Transactions and agent actions will appear here once they occur.")}</Text>
            </div>
          ) : (
            <div className="ActivityLog__list">
              {logs.map((log, index) => (
                <div 
                  key={log._id} 
                  className="ActivityLog__item"
                  ref={index === logs.length - 1 ? lastElementRef : null}
                >
                  <div className="ActivityLog__item__content">
                    <div className="ActivityLog__item__row">
                      <span className="ActivityLog__item__title">
                        {log.amount}
                      </span>
                      <span className={`ActivityLog__item__status ActivityLog__item__status--${log.status}`}>
                        {log.status === "failure" ? t("Failed") : t("Success")}
                      </span>
                    </div>
                    <div className="ActivityLog__item__details">
                      {log.reason && (
                        <span className="ActivityLog__item__info">
                          {log.reason}
                        </span>
                      )}
                    </div>
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
