// Opt-in process-local diagnosis. Never alter Windows proxy settings or make
// packaged clients silently bypass the user's configured proxy.
export function developmentDirectNetwork(env = process.env) {
  return Boolean(env.VELUNE_DESKTOP_DEV_SERVER_URL || env.VELUNE_DESKTOP_DEV_SERVER_URL || env.VELUNE_DESKTOP_DEV_SERVER_URL)
    && env.VELUNE_DEV_NETWORK_MODE === "direct";
}
