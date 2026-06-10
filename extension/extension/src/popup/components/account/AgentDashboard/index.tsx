// AgentDashboard — placeholder tab content shown when the user picks the
// "Agent Dashboard" tab from the account view. The full agent UX is still
// in design; this stub exists so the tab strip can ship today with a
// non-empty pane.

import React from "react";
import { useTranslation } from "react-i18next";
import { Notification, Text } from "@stellar/design-system";

import "./styles.scss";

export const AgentDashboard = () => {
  const { t } = useTranslation();

  return (
    <div className="AgentDashboard" data-testid="agent-dashboard">
      <Notification variant="primary" title={t("Agents — coming soon")}>
        {t(
          "This is where your active and saved Aptopia agents will live. Wire up autonomous yield rebalancing, cross-DEX routing, and DCA strategies.",
        )}
      </Notification>
      <div className="AgentDashboard__hint">
        <Text as="p" size="sm" color="gray-500">
          {t(
            "Want to influence what ships here? Drop ideas in the Aptopia Discord.",
          )}
        </Text>
      </div>
    </div>
  );
};
