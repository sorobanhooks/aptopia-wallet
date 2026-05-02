import React, { useState, useEffect, useCallback } from "react";
import { Button, Input, Notification, Icon, Card, Loader } from "@stellar/design-system";
import { useTranslation } from "react-i18next";
import { Formik, Form, Field, FieldProps } from "formik";
import * as Yup from "yup";
import { useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";

import { View } from "popup/basics/layout/View";
import { SubviewHeader } from "popup/components/SubviewHeader";
import { agentBackendService } from "api/agentBackendService";
import { publicKeySelector, agentAddressSelector, setAgentAddress } from "popup/ducks/accountServices";
import { ROUTES } from "popup/constants/routes";
import { navigateTo } from "popup/helpers/navigate";
import { useDispatch } from "react-redux";

import "./styles.scss";

interface RuleValues {
  autoThreshold: number;
  blockThreshold: number;
  dailyBudget: number;
  buyBelowUsd: number;
  sellAboveUsd: number;
  buyAmountUsdc: number;
  sellAmountXlm: number;
}

const RulesSchema = Yup.object().shape({
  autoThreshold: Yup.number().positive().required(),
  blockThreshold: Yup.number().positive().min(Yup.ref("autoThreshold"), "Must be greater than auto threshold").required(),
  dailyBudget: Yup.number().positive().required(),
  buyBelowUsd: Yup.number().positive().required(),
  sellAboveUsd: Yup.number().positive().moreThan(Yup.ref("buyBelowUsd"), "Must be greater than buy price").required(),
  buyAmountUsdc: Yup.number().positive().required(),
  sellAmountXlm: Yup.number().positive().required(),
});

export const AgentConfig = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const publicKey = useSelector(publicKeySelector);
  const reduxAgentAddress = useSelector(agentAddressSelector);
  const [isSaveSuccess, setIsSaveSuccess] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [rules, setRules] = useState<RuleValues | null>(null);
  const [revokeError, setRevokeError] = useState("");

  const fetchRules = useCallback(async () => {
    if (!publicKey) return;
    setIsInitialLoading(true);
    try {
      let agentAddress = reduxAgentAddress;

      // Ensure we have the agent address first
      if (!agentAddress) {
        const metricsData = await agentBackendService.getMetrics(publicKey);
        agentAddress = metricsData.agentAddress;
        dispatch(setAgentAddress(agentAddress));
      }

      const data = await agentBackendService.getRules(agentAddress);
      const mappedRules: RuleValues = {
        autoThreshold: data.tier1Max,
        blockThreshold: data.tier2Max,
        dailyBudget: data.dailyBudget,
        buyBelowUsd: data.buyBelowUsd,
        sellAboveUsd: data.sellAboveUsd,
        buyAmountUsdc: data.buyAmountUsdc,
        sellAmountXlm: data.sellAmountXlm,
      };
      setRules(mappedRules);
    } catch (e) {
      console.error("Failed to fetch rules:", e);
    } finally {
      setIsInitialLoading(false);
    }
  }, [publicKey, reduxAgentAddress, dispatch]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleSubmit = async (values: RuleValues) => {
    try {
      if (!reduxAgentAddress) throw new Error("Agent address not resolved");

      await agentBackendService.updateRules(reduxAgentAddress, {
        tier1Max: values.autoThreshold,
        tier2Max: values.blockThreshold,
        dailyBudget: values.dailyBudget,
        buyBelowUsd: values.buyBelowUsd,
        sellAboveUsd: values.sellAboveUsd,
        buyAmountUsdc: values.buyAmountUsdc,
        sellAmountXlm: values.sellAmountXlm,
      });

      setIsSaveSuccess(true);
      setTimeout(() => setIsSaveSuccess(false), 3000);
    } catch (e) {
      console.error("Failed to update rules:", e);
      alert(t("Failed to save changes. Please try again."));
    }
  };

  const handleRevoke = async () => {
    if (!window.confirm(t("Are you sure you want to revoke the agent wallet? This action is permanent and will return all USDC to your main wallet."))) {
      return;
    }

    setRevokeError("");
    setIsRevoking(true);
    try {
      if (!reduxAgentAddress) throw new Error("Agent address not resolved");

      const res = await agentBackendService.revokeAgent(reduxAgentAddress);
      if (res.ok) {
        navigateTo(ROUTES.dashboard, navigate);
      } else if (res.error) {
        setRevokeError(res.error);
      } else {
        setRevokeError(t("Failed to revoke agent wallet. Please try again."));
      }
    } catch (e) {
      console.error("Revoke failed:", e);
      setRevokeError(e instanceof Error ? e.message : t("An error occurred while revoking the agent."));
    } finally {
      setIsRevoking(false);
    }
  };

  if (isInitialLoading) {
    return (
      <React.Fragment>
        <SubviewHeader title={t("Agent Configuration")} />
        <View.Content>
          <div className="AgentConfig__loading">
            <Loader />
          </div>
        </View.Content>
      </React.Fragment>
    );
  }

  const initialValues: RuleValues = rules || {
    autoThreshold: 5,
    blockThreshold: 50,
    dailyBudget: 10,
    buyBelowUsd: 0.1,
    sellAboveUsd: 0.5,
    buyAmountUsdc: 1,
    sellAmountXlm: 10,
  };

  return (
    <React.Fragment>
      <SubviewHeader title={t("Agent Configuration")} />
      <View.Content hasNoTopPadding>
        <div className="AgentConfig">
          <Formik
            initialValues={initialValues}
            validationSchema={RulesSchema}
            onSubmit={handleSubmit}
            enableReinitialize
          >
            {({ errors, touched, isValid, dirty, isSubmitting }) => (
              <Form>
                <section className="AgentConfig--section">
                  <div className="AgentConfig--section--title">
                    <span>{t("Trading Price Rules")}</span>
                  </div>
                  <div className="AgentConfig__rules-form">
                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Buy XLM when price is at or below ($):")}</label>
                      <Field name="buyBelowUsd">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="buyBelowUsd-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.buyBelowUsd && touched.buyBelowUsd ? errors.buyBelowUsd : ""}
                          />
                        )}
                      </Field>
                    </div>

                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Sell XLM when price is at or above ($):")}</label>
                      <Field name="sellAboveUsd">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="sellAboveUsd-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.sellAboveUsd && touched.sellAboveUsd ? errors.sellAboveUsd : ""}
                          />
                        )}
                      </Field>
                    </div>
                  </div>

                  <div className="AgentConfig--section--title" style={{ marginTop: "24px" }}>
                    <span>{t("Amount Limits")}</span>
                  </div>

                  <div className="AgentConfig__rules-form">
                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Max USDC per auto (Tier 1) buy:")}</label>
                      <Field name="autoThreshold">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="autoThreshold-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.autoThreshold && touched.autoThreshold ? errors.autoThreshold : ""}
                          />
                        )}
                      </Field>
                    </div>

                    {/* <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Max USDC per confirm (Tier 2) buy:")}</label>
                      <Field name="blockThreshold">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="blockThreshold-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.blockThreshold && touched.blockThreshold ? errors.blockThreshold : ""}
                          />
                        )}
                      </Field>
                    </div> */}

                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Max USDC spend on buys per UTC day:")}</label>
                      <Field name="dailyBudget">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="dailyBudget-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.dailyBudget && touched.dailyBudget ? errors.dailyBudget : ""}
                          />
                        )}
                      </Field>
                    </div>

                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Fixed USDC amount per buy:")}</label>
                      <Field name="buyAmountUsdc">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="buyAmountUsdc-input"
                            type="number"
                            fieldSize="md"
                            prefix="$"
                            error={errors.buyAmountUsdc && touched.buyAmountUsdc ? errors.buyAmountUsdc : ""}
                          />
                        )}
                      </Field>
                    </div>

                    <div className="AgentConfig__rule-field">
                      <label className="AgentConfig__rule-label">{t("Fixed XLM amount per sell:")}</label>
                      <Field name="sellAmountXlm">
                        {({ field }: FieldProps) => (
                          <Input
                            {...field}
                            id="sellAmountXlm-input"
                            type="number"
                            fieldSize="md"
                            error={errors.sellAmountXlm && touched.sellAmountXlm ? errors.sellAmountXlm : ""}
                          />
                        )}
                      </Field>
                    </div>

                    <Button
                      size="lg"
                      variant="secondary"
                      isRounded
                      type="submit"
                      isFullWidth
                      disabled={!isValid || !dirty || isSubmitting}
                      isLoading={isSubmitting}
                      className="AgentConfig__save-btn"
                    >
                      {t("Save Changes")}
                    </Button>

                    {isSaveSuccess && (
                      <div className="AgentConfig__success-msg">
                        <Notification variant="success" title={t("Settings saved successfully!")} />
                      </div>
                    )}
                  </div>
                </section>
              </Form>
            )}
          </Formik>

          <div className="AgentConfig__revoke-container">
            <Card variant="secondary">
              <div className="AgentConfig__revoke-card">
                <div className="AgentConfig--section--subtitle" style={{ marginBottom: "16px" }}>
                  {t("Revoking the agent wallet will permanently remove its access to your funds and disable all automated features.")}
                </div>

                {revokeError && (
                  <div className="AgentConfig__revoke-error">
                    <Notification variant="error" title={revokeError} />
                  </div>
                )}

                <Button
                  size="md"
                  variant="error"
                  isFullWidth
                  isRounded
                  icon={<Icon.LinkBroken01 />}
                  iconPosition="left"
                  isLoading={isRevoking}
                  disabled={isRevoking}
                  onClick={handleRevoke}
                >
                  {t("Revoke agent wallet")}
                </Button>
              </div>
            </Card>
          </div>
        </div>
      </View.Content>
    </React.Fragment>
  );
};
