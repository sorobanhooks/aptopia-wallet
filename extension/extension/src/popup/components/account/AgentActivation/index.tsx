import React, { useState } from "react";
import { Heading, Button, CopyText, Icon, Input, Text } from "@stellar/design-system";
import { useTranslation } from "react-i18next";

import { truncatedPublicKey } from "helpers/stellar";
import { useFundAgent } from "./useFundAgent";
import "./styles.scss";

interface Props {
  agentAddress: string;
  funded: boolean;
  usdcTrustlineReady: boolean;
  onRefresh: () => void;
  onOpenTelegram: () => void;
  onManageRules: () => void;
}

const DEFAULT_FUND_AMOUNT = "3";

export const AgentActivation = ({
  agentAddress,
  funded,
  usdcTrustlineReady,
  onRefresh,
  onOpenTelegram,
  onManageRules,
}: Props) => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(DEFAULT_FUND_AMOUNT);
  const { fund, isFunding, error } = useFundAgent(onRefresh);
  const amountValid = Number(amount) > 0;

  return (
    <div className="AgentActivation">
      <Heading as="h1" size="xs">
        {t("Activate your agent")}
      </Heading>

      <div
        className={`AgentActivation__step ${funded ? "is-done" : "is-active"}`}
      >
        <div className="AgentActivation__step__title">
          {funded ? (
            <Icon.CheckCircle />
          ) : (
            <span className="AgentActivation__num">1</span>
          )}{" "}
          {t("Fund agent")}
        </div>
        {!funded && (
          <>
            <div className="AgentActivation__addr">
              <span>{truncatedPublicKey(agentAddress, 8)}</span>
              <CopyText textToCopy={agentAddress} doneLabel={t("Copied!")}>
                <div className="AgentActivation__copy">
                  <Icon.Copy01 />
                </div>
              </CopyText>
            </div>
            <Input
              fieldSize="md"
              id="agent-fund-amount"
              type="number"
              min="0"
              step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="agent-fund-amount"
              aria-label={t("Fund amount (XLM)")}
            />
            <Text as="p" size="xs">
              {t("~1 XLM stays locked as the account reserve.")}
            </Text>
            {error && (
              <Text as="p" size="xs" addlClassName="AgentActivation__error">
                {error}
              </Text>
            )}
            <Button
              size="md"
              variant="primary"
              isFullWidth
              isLoading={isFunding}
              disabled={!amountValid || isFunding}
              data-testid="agent-fund-button"
              onClick={() => {
                // Normalize to ≤7 decimal places (Stellar precision) at submit
                // time; don't alter the input's displayed value on every keystroke.
                const normalizedAmount = Number(amount)
                  .toFixed(7)
                  .replace(/\.?0+$/, "");
                fund({ agentAddress, amount: normalizedAmount });
              }}
            >
              {t("Fund agent")}
            </Button>
          </>
        )}
      </div>

      <div
        className={`AgentActivation__step ${usdcTrustlineReady ? "is-done" : funded ? "is-active" : ""}`}
      >
        <div className="AgentActivation__step__title">
          {usdcTrustlineReady ? (
            <Icon.CheckCircle />
          ) : (
            <span className="AgentActivation__num">2</span>
          )}{" "}
          {t("Add USDC trustline")}
        </div>
        {funded && !usdcTrustlineReady && (
          <>
            <Text as="p" size="xs">
              {t(
                "Run /createtrustline in Telegram (the agent signs this itself).",
              )}
            </Text>
            <Button
              size="md"
              variant="secondary"
              isFullWidth
              onClick={onOpenTelegram}
              data-testid="agent-trustline-telegram"
            >
              {t("Open Telegram")}
            </Button>
          </>
        )}
      </div>

      <div className={`AgentActivation__step ${usdcTrustlineReady ? "is-done" : ""}`}>
        <div className="AgentActivation__step__title">
          <span className="AgentActivation__num">3</span> {t("Set rules")}
        </div>
        {usdcTrustlineReady && (
          <Button
            size="md"
            variant="secondary"
            isFullWidth
            onClick={onManageRules}
          >
            {t("Set trading rules")}
          </Button>
        )}
      </div>

      <button
        type="button"
        className="AgentActivation__refresh"
        onClick={onRefresh}
        data-testid="agent-activation-refresh"
      >
        {t("Refresh")}
      </button>
    </div>
  );
};
