import { injectWalletGlobals } from "contentScript/helpers/injectWalletGlobals";
import { redirectMessagesToBackground } from "contentScript/helpers/redirectMessagesToBackground";

injectWalletGlobals();
redirectMessagesToBackground();
