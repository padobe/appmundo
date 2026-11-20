# Planeta en vivo

Un globo terráqueo 3D con lo que está pasando en el mundo **ahora mismo**:

- **Día y noche en tiempo real**: la posición del sol se calcula a partir de la hora UTC y un shader mezcla la Tierra de día con las luces de las ciudades, con terminador suave, reflejo del sol en el mar, halo atmosférico y bloom (en escritorio).
- **Zoom hasta el suelo en 3D**: imágenes de satélite de alta resolución y relieve real (montañas con luz y sombra según el sol). Clic derecho o Ctrl + arrastrar para inclinar la vista; al acercarse se inclina sola y aparece el cielo y la bruma.
- **Cielo real**: unas 4.000 estrellas en su posición según la hora sidérea, constelaciones con nombres en español y la Luna en su posición y fase reales.
- **Satélites en directo**: brillantes, GPS/navegación, geoestacionarios y Starlink (este último apagado por defecto), calculados con SGP4 en un Web Worker.
- **Auroras** (previsión NOAA OVATION), **viento** con partículas (apagado por defecto), **nubes reales**, **terremotos** de 24 h, **desastres activos** de NASA (incendios, tormentas con su trayectoria, volcanes…) y la **ISS** con su estela.
- **Eventos en detalle (GDACS)**: alertas verdes, naranjas y rojas de terremotos, ciclones, inundaciones e incendios; al pulsar una la cámara vuela al terreno y se abre un panel con fuente y fecha, la línea de tiempo del evento y una gráfica (en ciclones: viento por aviso, observado y previsión).
- **Desde aquí**: escribe una calle, ciudad o zona y verás su hora local, salida y puesta del sol, la Luna, el tiempo, la probabilidad de aurora, lo que ha pasado cerca y los próximos pasos visibles de la ISS. No usa tu ubicación.
- **Foto real de ayer** (NASA GIBS, satélites VIIRS) como imagen del planeta, con las nubes, la nieve y el humo de verdad.
- **Planetas y Sol** en su posición real, **eclipses** (lista de los próximos, viaje al momento exacto, sombra de la Luna sobre la Tierra, línea central y visor de la Luna en los lunares).
- **Atmósfera más realista**: luz cálida con el sol bajo, contraluz al amanecer visto desde el espacio, sombra de las nubes y oleaje en el brillo del mar.
- **Repetición de un año**: estaciones, Luna, planetas y terremotos M6+ del último año.
- **Terremotos más ricos**: clic para ver profundidad en 3D, ondas P y S, alerta PAGER, indicador de tsunami, intensidad y tiempos de llegada de las ondas a tu lugar.
- **Vídeo en directo de la ISS** (canal oficial de la NASA).
- **Teclado y accesibilidad**: atajos (pulsa ?), enlace para saltar al buscador, anuncios para lectores de pantalla.
- **Tour cinematográfico**: un recorrido automático por lo más interesante del momento.
- **Repetición de 24 h** con la línea de tiempo, y un panel de **capas** para encender y apagar cada cosa.

Es una web estática, sin paso de build ni backend: `index.html` + JS/CSS planos, con three.js cargado desde CDN mediante un *import map*.

## Verla en local

Hace falta un servidor HTTP (los módulos ES no funcionan abriendo el archivo con `file://`):

```sh
npx serve .
```

y abre la dirección que indique (por defecto http://localhost:3000).

## Publicación (GitHub Pages)

Basta con activar GitHub Pages desde la rama `main` (carpeta raíz). No hay backend ni Actions: todo se pide desde el navegador de cada visitante a servicios gratuitos y sin clave.

### Uso de los servicios

| Datos | Servicio | Uso que hace la web |
|---|---|---|
| Terremotos | USGS | 1 petición cada 5 min |
| ISS | wheretheiss.at | 1 cada 5 s mientras la pestaña está visible |
| Satélites | CelesTrak | 1 descarga por grupo cada 2 h como máximo (caché en el navegador, como pide CelesTrak). Si fallara, se usa la copia de `assets/sky/tle/` |
| Auroras | NOAA SWPC | 1 cada 10 min |
| Desastres | NASA EONET | 1 cada 30 min |
| Viento | Open-Meteo | 1 cada hora como mucho (caché), solo si la capa está activa |
| Tiempo de un lugar | Open-Meteo | 1 por búsqueda |
| Búsqueda de lugares | Photon (OpenStreetMap) | 1 por búsqueda, solo al pulsar Intro |
| Nubes | live-cloud-maps | 1 cada hora |
| Foto de ayer | NASA GIBS | 1 por visita |
| Terremotos del año | USGS FDSN | 1 al abrir la repetición de un año |
| Planetas y eclipses | astronomy-engine (MIT) | se calcula en el navegador: sin peticiones |
| Vídeo de la ISS | NASA (IBM Video) | solo al abrir el panel |
| Imágenes y relieve | Esri World Imagery, AWS Terrain Tiles | teselas según lo que se ve |

Para refrescar de vez en cuando la copia de respaldo de órbitas: `node scripts/update-tle.mjs`.

## Estructura

```
index.html              interfaz e import map
css/style.css           estilos
js/main.js              escena, cámara, zoom, bloom, bucle y registro de capas
js/globe.js             shader del planeta (compartido con las teselas), atmósfera y cielo
js/tiles.js             imágenes de satélite y relieve 3D por teselas (quadtree)
js/timeline.js          reloj de la escena: directo o repetición de 24 h
js/sun.js               posición del sol
js/geo.js, regions.js   utilidades geográficas
js/sky.js               estrellas, constelaciones, Luna y bóveda celeste
js/astro.js             Sol, Luna, fases, salida/puesta del sol, tiempo sidéreo
js/place.js             búsqueda y ficha "Desde aquí"
js/tour.js              tour cinematográfico
js/workers/             cálculo de órbitas (SGP4) en segundo plano
js/layers/*.js          una capa por fuente de datos (terremotos, ISS, satélites, auroras, viento, EONET, nubes)
scripts/update-tle.mjs  copia de respaldo de órbitas
assets/sky/             catálogo de estrellas, constelaciones y órbitas de respaldo
assets/textures/        texturas de la Tierra y del cielo
```

Para añadir una fuente nueva (satélites, auroras…) se crea una clase en `js/layers/` con `start()`, `update(dt)`, `pick(x, y, radio)` y `setVisible(on)`, y se registra en `js/main.js`. La hora se pide siempre a `ctx.time.now()`, así la capa funciona también en la repetición.

## Fuentes de datos y créditos

- Terremotos: [USGS Earthquake Hazards Program](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), feed GeoJSON `all_day`.
- ISS: [Where the ISS at?](https://wheretheiss.at/w/developer) (`api.wheretheiss.at`), también usada para saber sobre qué país pasa.
- Nubes: [live-cloud-maps](https://github.com/matteason/live-cloud-maps) de Matt Eason (datos de EUMETSAT y NOAA).
- Imágenes de satélite y nombres: Esri World Imagery y World Boundaries and Places (Esri, Maxar, Earthstar Geographics y la comunidad de usuarios de GIS), con atribución.
- Texturas del globo: NASA Blue Marble y Earth at Night (Visible Earth), en las versiones que distribuye [three-globe](https://github.com/vasturiano/three-globe) (MIT).
- Satélites: [CelesTrak](https://celestrak.org/) (datos GP/TLE) y [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
- Auroras: [NOAA SWPC](https://www.swpc.noaa.gov/) (modelo OVATION, dominio público).
- Desastres: [NASA EONET](https://eonet.gsfc.nasa.gov/).
- Viento y tiempo: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0, uso no comercial).
- Búsqueda: [Photon](https://photon.komoot.io/) de komoot, datos © [OpenStreetMap](https://www.openstreetmap.org/copyright).
- Relieve: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; fuentes SRTM, GMTED, ETOPO1 y otras).
- Estrellas y constelaciones: [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3).
- Luna: NASA Scientific Visualization Studio, CGI Moon Kit (dominio público).
- Render 3D: [three.js](https://threejs.org/) (MIT).
