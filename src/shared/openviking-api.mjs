export const OPENVIKING_API_VERSION = 1;
export const OPENVIKING_API_PREFIX = `/api/v${OPENVIKING_API_VERSION}`;

export function openVikingApiPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.startsWith("/")) {
    throw new TypeError("OpenViking API path must start with /");
  }
  return `${OPENVIKING_API_PREFIX}${relativePath}`;
}
