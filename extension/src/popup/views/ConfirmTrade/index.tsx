import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button, Heading, Card, Icon } from "@stellar/design-system";

import { View } from "popup/basics/layout/View";
import { SubviewHeader } from "popup/components/SubviewHeader";
import { ROUTES } from "popup/constants/routes";
import { navigateTo } from "popup/helpers/navigate";

import "./styles.scss";

export const ConfirmTrade = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const handleApprove = () => {
    navigateTo(ROUTES.dashboard, navigate);
  };

  const handleReject = () => {
    navigateTo(ROUTES.dashboard, navigate);
  };

  return (
    <React.Fragment>
      <SubviewHeader title={t("Review Trade")} />
      <View.Content hasNoTopPadding>
        <div className="ConfirmTrade">
          <div className="ConfirmTrade__hero">
            <div className="ConfirmTrade__badge">
              <Icon.Activity size="14px" />
              <span>{t("Agent Buy")}</span>
            </div>
            <div className="ConfirmTrade__amount-display">
              <span className="ConfirmTrade__currency-symbol">$</span>
              <span className="ConfirmTrade__amount">10.00</span>
            </div>
            <div className="ConfirmTrade__asset-details">
              <span className="ConfirmTrade__asset-code">XLM</span>
              <span className="ConfirmTrade__at-price">{t("at $0.38/XLM")}</span>
            </div>
          </div>

          <Card variant="secondary">
            <div className="ConfirmTrade__card">
              <Heading as="h2" size="xs" weight="semi-bold" className="ConfirmTrade__title">
                {t("Confirm Agent Trade")}
              </Heading>

              <div className="ConfirmTrade__details-list">
                <div className="ConfirmTrade__detail-row">
                  <div className="ConfirmTrade__detail-label-group">
                    <Icon.Target01 size="16px" color="var(--sds-clr-gray-09)" />
                    <span className="ConfirmTrade__detail-label">{t("Trigger")}</span>
                  </div>
                  <span className="ConfirmTrade__detail-value">{t("5.2% drop")}</span>
                </div>

                <div className="ConfirmTrade__detail-row">
                  <div className="ConfirmTrade__detail-label-group">
                    <Icon.Wallet01 size="16px" color="var(--sds-clr-gray-09)" />
                    <span className="ConfirmTrade__detail-label">{t("Source")}</span>
                  </div>
                  <span className="ConfirmTrade__detail-value">{t("Main wallet")}</span>
                </div>

                <div className="ConfirmTrade__detail-row">
                  <div className="ConfirmTrade__detail-label-group">
                    <Icon.Coins01 size="16px" color="var(--sds-clr-gray-09)" />
                    <span className="ConfirmTrade__detail-label">{t("Est. Fee")}</span>
                  </div>
                  <span className="ConfirmTrade__detail-value ConfirmTrade__detail-value--italic">
                    ~0.01 XLM
                  </span>
                </div>
              </div>

              <div className="ConfirmTrade__actions">
                <Button
                  size="md"
                  variant="secondary"
                  isFullWidth
                  isRounded
                  onClick={handleApprove}
                >
                  {t("Approve")}
                </Button>
                <Button
                  size="md"
                  variant="tertiary"
                  isFullWidth
                  isRounded
                  onClick={handleReject}
                >
                  {t("Reject")}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </View.Content >
    </React.Fragment >
  );
};
