import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { myAppPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { MyCowlabConfigSchema } from "./src/config/config-schema.js";

export default {
  id: "openclaw-cowlab",
  name: "MyCowlab",
  description: "MyCowlab channel (long-poll upstream + HTTP send downstream)",
  configSchema: buildChannelConfigSchema(MyCowlabConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    assertHostCompatibility(api.runtime?.version);

    api.registerChannel({ plugin: myAppPlugin });
  },
};
