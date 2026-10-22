const WINDOWS_LOCAL_FILE_REFERENCE_PATTERN = /^(?:file:\/\/|\/?[a-z]:[\\/]|\\\\)/i;
const SOURCE_LOCATION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const FILE_DESCRIPTION_SUFFIX_PATTERN = /(\.[a-z][a-z0-9]{0,11})[:\uFF1A](?!\d+(?::\d+)?$).*$/i;

export function stripWindowsLocalFileDescriptionSuffix(value) {
  const text = String(value || "");
  if (!WINDOWS_LOCAL_FILE_REFERENCE_PATTERN.test(text)) return text;
  return text.replace(FILE_DESCRIPTION_SUFFIX_PATTERN, "$1");
}

export function stripWindowsSourceLocationSuffix(value) {
  const text = String(value || "");
  if (!WINDOWS_LOCAL_FILE_REFERENCE_PATTERN.test(text)) return text;
  return text.replace(SOURCE_LOCATION_SUFFIX_PATTERN, "");
}
