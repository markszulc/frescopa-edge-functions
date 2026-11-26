/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/
// Open-Meteo.com API data are offered under Attibution 4.0 International (CC BY 4.0) license.
// Please see https://open-meteo.com/en/licence for more information.

/// <reference types="@fastly/js-compute" />

import { getGeolocationForIpAddress } from 'fastly:geolocation';
const apiUrl = 'https://api.open-meteo.com/v1/forecast';
const cacheTtl = 300;

export async function weatherHandler(req, client) {
  // The CDN puts the caller's IP in the URL so weather responses are cached per client.
  const clientIp = new URL(req.url).searchParams.get('ip') || client?.address;
  if (!clientIp) {
    console.warn('Weather request has no client IP');
    return new Response('Client IP unavailable', {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    });
  }

  try {
    const location = getGeolocationForIpAddress(clientIp);
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      console.warn('Weather geolocation unavailable');
      return new Response('Could not determine your location', {
        headers: { 'cache-control': `public, max-age=${cacheTtl}` },
      });
    }
    const url = new URL(apiUrl);
    url.search = new URLSearchParams({
      current: 'temperature_2m',
      latitude: location.latitude,
      longitude: location.longitude,
    }).toString();
    // Open-Meteo's public reference API does not require an API token.
    const res = await fetch(url.href);
    if (!res.ok) throw new Error(`Weather API returned HTTP ${res.status}`);
    const data = await res.json();
    const temperature = data.current?.temperature_2m;
    if (!Number.isFinite(temperature)) throw new Error('Weather API returned no valid temperature');
    return new Response(
      `It seems you are based in ${location.city} (Weather data by Open-Meteo.com - https://open-meteo.com/) where the local temperature is ${temperature}°C`,
      { headers: { 'cache-control': `public, max-age=${cacheTtl}` } },
    );
  } catch (error) {
    console.error('Weather request failed', error);
    return new Response('Weather data unavailable', {
      status: 502,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
