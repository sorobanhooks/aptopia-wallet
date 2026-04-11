import React, { useState, useEffect, useCallback } from "react";
import {
  Heading,
  Button,
  CopyText,
  Icon,
  Loader,
  Text,
} from "@stellar/design-system";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";

import { View } from "popup/basics/layout/View";
import { ROUTES } from "popup/constants/routes";
import { navigateTo, openTab } from "popup/helpers/navigate";
import { publicKeySelector, setAgentAddress } from "popup/ducks/accountServices";
import { settingsNetworkDetailsSelector } from "popup/ducks/settings";
import { truncatedPublicKey, getExplorerUrl, getAccountExplorerUrl } from "helpers/stellar";
import { agentBackendService } from "api/agentBackendService";
import { AgentMetrics, AgentLog } from "api/types";
import { TELEGRAM_BOT } from "constants/env";
import { useDispatch } from "react-redux";

import "./styles.scss";

enum AgentFetchStatus {
  LOADING = "LOADING",
  UNCONNECTED = "UNCONNECTED",
  CONNECTED = "CONNECTED",
}

export const Dashboard = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const publicKey = useSelector(publicKeySelector);
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const [status, setStatus] = useState<AgentFetchStatus>(AgentFetchStatus.LOADING);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [recentLogs, setRecentLogs] = useState<AgentLog[]>([]);

  const getAgentDetails = useCallback(async () => {
    if (!publicKey) return;

    setStatus(AgentFetchStatus.LOADING);
    try {
      const metricsData = await agentBackendService.getMetrics(publicKey);
      const agentAddress = metricsData.agentAddress;

      // Store globally for other pages to reuse
      dispatch(setAgentAddress(agentAddress));

      const logsData = await agentBackendService.getLogs(agentAddress, 1, 5);

      setMetrics(metricsData);
      setRecentLogs(logsData.items);
      setStatus(AgentFetchStatus.CONNECTED);
    } catch (e) {
      console.error("Failed to fetch agent details:", e);
      setStatus(AgentFetchStatus.UNCONNECTED);
    }
  }, [publicKey, dispatch]);

  useEffect(() => {
    getAgentDetails();
  }, [getAgentDetails]);

  // Re-fetch when the window regains focus (user returns from Telegram)
  useEffect(() => {
    const handleFocus = () => {
      getAgentDetails();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [getAgentDetails]);

  if (status === AgentFetchStatus.LOADING) {
    return (
      <View.Content>
        <div className="Dashboard__loading">
          <Loader />
          <Text as="p" size="sm" color="gray-500">
            {t("Fetching agent details...")}
          </Text>
        </div>
      </View.Content>
    );
  }

  if (status === AgentFetchStatus.UNCONNECTED) {
    return (
      <View.Content>
        <div className="Dashboard__unconnected">
          <div className="Dashboard__unconnected__icon">
            <Icon.Globe02 />
          </div>
          <Heading as="h1" size="xs" addlClassName="Dashboard__unconnected__title">
            {t("Connect Your AI Agent")}
          </Heading>
          <Text as="p" size="sm" color="gray-500" addlClassName="Dashboard__unconnected__desc">
            {t("It looks like you don't have an AI agent associated with this wallet yet. Create one in seconds using Telegram.")}
          </Text>
          <div className="Dashboard__unconnected__actions">
            <Button
              size="md"
              variant="secondary"
              isFullWidth
              onClick={() => navigateTo(ROUTES.account, navigate)}
              icon={<Icon.ArrowLeft />}
              iconPosition="left"
            >
              {t("Back")}
            </Button>
            <Button
              size="md"
              variant="primary"
              isFullWidth
              onClick={() => {
                const botUrl = `${TELEGRAM_BOT}?start=${publicKey}`;
                openTab(botUrl);
              }}
            >
              {t("Open Telegram")}
            </Button>
          </div>
        </div>
      </View.Content>
    );
  }

  return (
    <React.Fragment>
      <View.Content>
        <div className="Dashboard">
          <header className="Dashboard__header">
            <div className="Dashboard__header__left">
              <div
                className="Dashboard__header__back-btn"
                onClick={() => navigateTo(ROUTES.account, navigate)}
              >
                <Icon.ArrowLeft />
              </div>
              <Heading as="h1" size="sm" addlClassName="Dashboard__header__title">
                {t("Agent wallet")}
              </Heading>
            </div>
            <div className="Dashboard__header__badge">
              {metrics?.status === "healthy" ? t("Active") : t("Inactive")}
            </div>
          </header>

          <div className="Dashboard__card">
            <div className="Dashboard__card__address-row">
              <a
                href={metrics?.agentAddress ? getAccountExplorerUrl(metrics.agentAddress, networkDetails) : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="Dashboard__card__address-link"
              >
                <span className="Dashboard__card__address">
                  {metrics?.agentAddress ? truncatedPublicKey(metrics.agentAddress, 8) : "..."}
                </span>
              </a>
              <CopyText textToCopy={metrics?.agentAddress || ""} doneLabel={t("Copied!")}>
                <div className="Dashboard__card__copy-btn">
                  <Icon.Copy01 />
                </div>
              </CopyText>
            </div>

            <div className="Dashboard__card__balances">
              <div className="Dashboard__card__balance-item">
                <span className="Dashboard__card__balance-label">{t("USDC Balance")}</span>
                <span className="Dashboard__card__balance">
                  {metrics?.balances.usdc || "0.00"} USDC
                </span>
              </div>
              <div className="Dashboard__card__balance-item">
                <span className="Dashboard__card__balance-label">{t("XLM Balance")}</span>
                <span className="Dashboard__card__balance">
                  {metrics?.balances.native || "0.00"} XLM
                </span>
              </div>
            </div>

            <div className="Dashboard__card__grid">
              <div className="Dashboard__card__stat">
                <span className="Dashboard__card__stat__label">{t("Today's Spend")}</span>
                <span className="Dashboard__card__stat__value">
                  ${metrics?.dailySpentUsd.toFixed(2) || "0.00"}
                </span>
              </div>
              <div className="Dashboard__card__stat">
                <span className="Dashboard__card__stat__label">{t("Daily Limit")}</span>
                <span className="Dashboard__card__stat__value">
                  ${metrics?.dailyLimitUsd.toFixed(2) || "0.00"}
                </span>
              </div>
              <div className="Dashboard__card__stat">
                <span className="Dashboard__card__stat__label">{t("Total Trades")}</span>
                <span className="Dashboard__card__stat__value">
                  {metrics?.totalSuccessfulTrades || 0}
                </span>
              </div>
              <div className="Dashboard__card__stat">
                <span className="Dashboard__card__stat__label">{t("Status")}</span>
                <span className="Dashboard__card__stat__value">
                  {metrics?.status ? metrics.status.charAt(0).toUpperCase() + metrics.status.slice(1) : t("N/A")}
                </span>
              </div>
            </div>
          </div>

          <div className="Dashboard__actions">
            <Button
              size="lg"
              variant="primary"
              isFullWidth
              icon={<Icon.Settings01 />}
              iconPosition="left"
              onClick={() => navigateTo(ROUTES.agentConfig, navigate)}
            >
              {t("Manage Agent Settings")}
            </Button>
          </div>

          <section className="Dashboard__activity">
            <div className="Dashboard__activity__header">
              <Heading as="h2" size="xs">
                {t("Recent Activity")}
              </Heading>
              <div
                className="Dashboard__activity__view-all"
                onClick={() => navigateTo(ROUTES.activityLog, navigate)}
              >
                {t("View All")}
                <Icon.ChevronRight />
              </div>
            </div>

            <div className="Dashboard__activity__list">
              {recentLogs.length > 0 ? (
                recentLogs.map((log) => (
                  <div key={log._id} className="Dashboard__activity__item">
                    <div className="Dashboard__activity__item__content">
                      <div className="Dashboard__activity__item__top">
                        <span className="Dashboard__activity__item__title">
                          {log.amount}
                        </span>
                        <span className={`Dashboard__activity__item__status Dashboard__activity__item__status--${log.status}`}>
                          {log.status}
                        </span>
                      </div>
                      <div className="Dashboard__activity__item__bottom">
                        <span className="Dashboard__activity__item__time">
                          {new Date(log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <a
                          href={getExplorerUrl(log.txHash, networkDetails)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="Dashboard__activity__item__link"
                        >
                          {truncatedPublicKey(log.txHash)}
                        </a>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="Dashboard__activity__empty">
                  <Text as="p" size="sm" color="gray-500">
                    {t("No recent activity discovered yet.")}
                  </Text>
                </div>
              )}
            </div>
          </section>
        </div>
      </View.Content>
    </React.Fragment>
  );
};
