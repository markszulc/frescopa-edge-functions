let location;
export const lookups = [];

export function setLocation(value) {
  location = value;
  lookups.length = 0;
}

export function getGeolocationForIpAddress(ip) {
  lookups.push(ip);
  return location;
}
