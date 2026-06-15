import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import { Loader, Text } from "@stellar/design-system";

import {
  settingsNetworkDetailsSelector,
} from "popup/ducks/settings";
import { getMonthLabel } from "popup/helpers/getMonthLabel";

import { HistoryItem } from "popup/components/accountHistory/HistoryItem";
import { TransactionDetail } from "popup/components/accountHistory/TransactionDetail";
import { View } from "popup/basics/layout/View";
import { RequestState } from "constants/request";
import { AppDataType } from "helpers/hooks/useGetAppData";
import { openTab } from "popup/helpers/navigate";
import { newTabHref } from "helpers/urls";
import { reRouteOnboarding } from "popup/helpers/route";
import { useGetHistoryData } from "./hooks/useGetHistoryData";
import { SlideupModal } from "popup/components/SlideupModal";

import "./styles.scss";

export const AccountHistory = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const networkDetails = useSelector(settingsNetworkDetailsSelector);
  const { state: historyState, fetchData } = useGetHistoryData({
    showHidden: false,
    includeIcons: true,
  });

  const [activeHistoryDetail, setActiveHistoryDetailId] = useState<
    string | null
  >(null);

  useEffect(() => {
    const getData = async () => {
      await fetchData(true, true);
    };
    getData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasError = historyState.state === RequestState.ERROR;
  const isResolved = historyState.data?.type === AppDataType.RESOLVED;

  if (historyState.data?.type === AppDataType.REROUTE) {
    if (historyState.data.shouldOpenTab) {
      openTab(newTabHref(historyState.data.routeTarget));
      window.close();
    }
    return (
      <Navigate
        to={`${historyState.data.routeTarget}${location.search}`}
        state={{ from: location }}
        replace
      />
    );
  }

  if (isResolved && !hasError) {
    reRouteOnboarding({
      type: historyState.data!.type,
      applicationState: historyState.data!.applicationState,
      state: historyState.state,
    });
  }

  const balances = isResolved ? historyState.data!.balances : undefined;
  const publicKey = isResolved ? historyState.data!.publicKey : undefined;
  const historySections = isResolved ? historyState.data!.history : [];

  const activeOperation =
    activeHistoryDetail && !hasError && isResolved
      ? historyState.data!.history
          .flat()
          .map((section: any) => section.operations)
          .flat()
          .find((op: any) => op.id === activeHistoryDetail)
      : undefined;

  return (
    <>
      <View.AppHeader hasBackButton pageTitle={t("History")} />
      <View.Content hasNoTopPadding hasNoBottomPadding>
        <div className="AccountHistory" data-testid="AccountHistory">
          {!hasError &&
            historySections.map((section: any) => (
              <div key={section.monthYear} className="AccountHistory__list">
                <Text
                  as="div"
                  size="sm"
                  addlClassName="AccountHistory__section-header"
                >
                  {getMonthLabel(Number(section.monthYear.split(":")[0]))}
                </Text>

                <div className="AccountHistory__list">
                  {section.operations.map((operation: any) => (
                    <HistoryItem
                      key={operation.id}
                      accountBalances={balances!}
                      operation={operation}
                      publicKey={publicKey!}
                      networkDetails={networkDetails}
                      setActiveHistoryDetailId={setActiveHistoryDetailId}
                    />
                  ))}
                </div>
              </div>
            ))}
          {hasError || (isResolved && historySections.length < 1) ? (
            <div style={{ padding: "1rem", textAlign: "center", color: "var(--sds-clr-gray-12)" }}>
              {hasError ? t("Error loading history") : t("No transactions to show")}
            </div>
          ) : null}
          {!isResolved && !hasError && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                flex: "1 0 auto",
                height: "100%",
                padding: "2rem",
              }}
            >
              <Loader size="3rem" />
            </div>
          )}
        </div>
      </View.Content>
      <SlideupModal
        isModalOpen={activeHistoryDetail !== null}
        setIsModalOpen={() => setActiveHistoryDetailId(null)}
      >
        <TransactionDetail
          activeOperation={activeOperation || null}
          networkDetails={networkDetails}
        />
      </SlideupModal>
    </>
  );
};
