import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Wisp Configuration: Refer to the documentation at https://www.npmjs.com/package/@mercuryworkshop/wisp-js

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});


// Cached public music chart endpoint for Pacific's Arcade.
// Apple Music RSS metadata only; audio playback remains on the existing service.
let chartCache = { data: null, expires: 0 };
fastify.get("/api/top-songs", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  reply.header("Cache-Control", "public, max-age=600");
  if (chartCache.data && Date.now() < chartCache.expires) return chartCache.data;
  const sources = [
    "https://rss.applemarketingtools.com/api/v2/us/music/most-played/100/songs.json",
    "https://itunes.apple.com/us/rss/topsongs/limit=100/json",
  ];
  for (const url of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "PacificArcade/1.0", Accept: "application/json, text/javascript, */*" } });
      if (!response.ok) throw new Error("upstream " + response.status);
      const raw = await response.text();
      const json = JSON.parse(raw);
      let songs;
      if (Array.isArray(json?.feed?.results)) songs = json.feed.results.map(x => ({
        id: String(x.id || ""), name: x.name, artistName: x.artistName,
        artworkUrl100: x.artworkUrl100 || "", url: x.url || ""
      }));
      else if (Array.isArray(json?.feed?.entry)) songs = json.feed.entry.map((x, i) => ({
        id: String(x?.id?.attributes?.["im:id"] || i),
        name: String(x?.["im:name"]?.label || ""),
        artistName: String(x?.["im:artist"]?.label || ""),
        artworkUrl100: String((x?.["im:image"] || []).at(-1)?.label || ""),
        url: String(x?.id?.label || "")
      }));
      else songs = [];
      songs = songs.filter(x => x.name && x.artistName).slice(0, 100);
      if (songs.length < 5) throw new Error("empty chart");
      const data = { feed: { results: songs }, fetchedAt: new Date().toISOString(), source: new URL(url).host };
      chartCache = { data, expires: Date.now() + 30 * 60 * 1000 };
      return data;
    } catch (e) { request.log.warn({ err: String(e), url }, "chart upstream failed"); }
  }
  if (chartCache.data) return chartCache.data;
  return reply.code(503).send({ error: "chart feed temporarily unavailable" });
});


// Actual per-genre US chart feeds for Pacific's Arcade music discovery.
// No keyword-search approximations or fabricated rankings.
const genreCharts = { pop: "14", hiphop: "18", country: "6", rock: "21", rnb: "15", dance: "17", alternative: "20", latin: "12" };
const genreChartCache = new Map();
fastify.get("/api/genre-songs", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  reply.header("Cache-Control", "public, max-age=600");
  const genre = String(request.query?.genre || "").toLowerCase();
  if (!Object.hasOwn(genreCharts, genre)) return reply.code(400).send({ error: "unknown genre" });
  const cached = genreChartCache.get(genre);
  if (cached && cached.expire > Date.now()) return cached.data;
  const id = genreCharts[genre];
  const feeds = [
    "https://rss.itunes.apple.com/api/v1/us/apple-music/top-songs/" + id + "/40/json",
    "https://itunes.apple.com/us/rss/topsongs/limit=40/genre=" + id + "/json",
    "https://rss.itunes.apple.com/api/v1/us/itunes-music/top-songs/" + id + "/40/json",
  ];
  for (const url of feeds) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8500), headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("upstream status " + res.status);
      const feed = await res.json();
      let songs = Array.isArray(feed?.feed?.results)
        ? feed.feed.results.map(x => ({ id: String(x.id || ""), name: x.name, artistName: x.artistName, artworkUrl100: x.artworkUrl100 || "", url: x.url || "" }))
        : Array.isArray(feed?.feed?.entry)
          ? feed.feed.entry.map((x, i) => ({ id: String(x?.id?.attributes?.["im:id"] || i), name: x?.["im:name"]?.label || "", artistName: x?.["im:artist"]?.label || "", artworkUrl100: (x?.["im:image"] || []).at(-1)?.label || "", url: x?.id?.label || "" }))
          : [];
      songs = songs.filter(x => x.name && x.artistName).slice(0, 40);
      if (songs.length < 6) throw new Error("upstream returned too few songs");
      const data = { genre, songs, fetchedAt: new Date().toISOString(), source: new URL(url).hostname };
      genreChartCache.set(genre, { data, expire: Date.now() + 30 * 60 * 1000 });
      return data;
    } catch (err) {
      request.log.warn({ genre, url, error: String(err) }, "genre chart failed");
    }
  }
  if (cached?.data) return cached.data;
  return reply.code(503).send({ error: "genre chart unavailable" });
});


fastify.get("/api/tmdb/tv/:id/season/:season", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Cross-Origin-Resource-Policy", "cross-origin");
  reply.header("Cache-Control", "public, max-age=3600");
  const id=String(request.params.id), season=String(request.params.season);
  if (!/^\\d{1,12}$/.test(id) || !/^\\d{1,3}$/.test(season)) return reply.code(400).send({error:"invalid tv id or season"});
  const token=process.env.TMDB_READ_TOKEN || process.env.TMDB_API_READ_ACCESS_TOKEN;
  const apiKey=process.env.TMDB_API_KEY;
  if (!token && !apiKey) return reply.code(503).send({error:"tmdb metadata not configured"});
  try {
    const url=new URL("https://api.themoviedb.org/3/tv/"+id+"/season/"+season);
    url.searchParams.set("language","en-US");
    if (!token) url.searchParams.set("api_key",apiKey);
    const headers={Accept:"application/json"};
    if (token) headers.Authorization="Bearer "+token;
    const upstream=await fetch(url,{headers,signal:AbortSignal.timeout(9000)});
    if (!upstream.ok) return reply.code(upstream.status).send({error:"tmdb metadata unavailable"});
    const data=await upstream.json();
    const episodes=(Array.isArray(data.episodes)?data.episodes:[])
      .filter(e=>Number.isInteger(e.episode_number)&&e.episode_number>0)
      .map(e=>({number:e.episode_number,name:e.name||"",overview:e.overview||"",airdate:e.air_date||"",still:e.still_path?"https://image.tmdb.org/t/p/w500"+e.still_path:""}));
    return {source:"tmdb",season:Number(season),episodes};
  } catch(error) {request.log.warn({error:String(error)},"tmdb season metadata failed");return reply.code(502).send({error:"tmdb metadata request failed"});}
});

fastify.setNotFoundHandler((res, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	// by default we are listening on 0.0.0.0 (every interface)
	// we just need to list a few
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});
