import {
  initContentScriptMessageListener,
  initExtensionMessageListener,
  initInstalledListener,
  initAlarmListener,
  initSDKStorage,
} from "background";

async function main() {
  // Ensure storage is ready before initializing listeners
  await initSDKStorage();
  
  initContentScriptMessageListener();
  initExtensionMessageListener();
  initInstalledListener();
  initAlarmListener();
}

main();
