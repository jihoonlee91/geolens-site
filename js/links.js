// 지도 앱 연동(길찾기·위치 보기)과 실제 사진(위키미디어 공용, 좌표 근처).
const isAndroid = /Android/i.test(navigator.userAgent), isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const inKorea = (lat, lon) => lat > 33 && lat < 39 && lon > 124.5 && lon < 131.9;

/** 지도 앱 목록: 한국 안이면 네이버·카카오 먼저. walk: 걷기 길찾기(가까운 곳·산). */
export function mapApps(name, lat, lon, walk, en) {
  const n = encodeURIComponent(name), mode = walk ? 'walk' : 'car';
  const naverWeb = `https://map.naver.com/p/search/${n}`;
  const naverApp = `nmap://route/${mode}?dlat=${lat}&dlng=${lon}&dname=${n}&appname=jihoonlee91.github.io`;
  const apps = [
    { key: 'naver', name: en ? 'Naver Map' : '네이버 지도',
      url: isAndroid ? `intent://route/${mode}?dlat=${lat}&dlng=${lon}&dname=${n}&appname=jihoonlee91.github.io#Intent;scheme=nmap;package=com.nhn.android.nmap;S.browser_fallback_url=${encodeURIComponent(naverWeb)};end` : naverApp,
      fallback: naverWeb },
    { key: 'kakao', name: en ? 'KakaoMap' : '카카오맵', url: `https://map.kakao.com/link/to/${n},${lat},${lon}` },
    { key: 'google', name: en ? 'Google Maps' : '구글 지도', url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=${walk ? 'walking' : 'driving'}` },
  ];
  if (isIOS) apps.push({ key: 'apple', name: en ? 'Apple Maps' : '애플 지도', url: `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=${walk ? 'w' : 'd'}&q=${n}` });
  if (!inKorea(lat, lon)) apps.sort((a, b) => (a.key === 'google' ? -1 : b.key === 'google' ? 1 : 0));
  return apps;
}

/** 앱 주소 열기(iOS의 nmap:// 처럼 앱이 없으면 아무 일도 없는 주소는 1.2초 뒤 웹으로). */
export function openApp(app) {
  if (app.url.startsWith('nmap://') && app.fallback) {
    const t = setTimeout(() => { location.href = app.fallback; }, 1200);
    addEventListener('pagehide', () => clearTimeout(t), { once: true });
    location.href = app.url;
  } else if (app.url.startsWith('intent://')) location.href = app.url;
  else window.open(app.url, '_blank');
}

/** 근처 실제 사진(위키미디어 공용): [{thumb, full, title, page}] */
export async function photosNear(lat, lon, radius = 1200, limit = 10) {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=${Math.min(10000, radius)}` +
    `&ggsnamespace=6&ggslimit=${limit}&prop=imageinfo|coordinates&iiprop=url|extmetadata&iiurlwidth=480&format=json&origin=*`;
  try {
    const j = await (await fetch(u)).json();
    return Object.values(j.query?.pages || {}).filter(p => p.imageinfo?.[0]?.thumburl && /\.(jpe?g|png|webp)$/i.test(p.title))
      .map(p => ({ thumb: p.imageinfo[0].thumburl, full: p.imageinfo[0].url, page: p.imageinfo[0].descriptionurl, title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        author: (p.imageinfo[0].extmetadata?.Artist?.value || '').replace(/<[^>]+>/g, '').slice(0, 40) }));
  } catch { return []; }
}
