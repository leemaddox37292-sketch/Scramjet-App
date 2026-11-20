import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
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
	root: epoxyPath,
	prefix: "/epoxy/",
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
  if (!/^\d{1,12}$/.test(id) || !/^\d{1,3}$/.test(season)) return reply.code(400).send({error:"invalid tv id or season"});
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


const tmdbLogoCache = new Map();
function normalizedMediaTitle(value) {
  return String(value||"").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
async function findKeylessLogo({type, title, year, imdbId}) {
  let resolvedId=/^tt\d{7,10}$/i.test(imdbId) ? imdbId : "";
  if (!resolvedId && title) {
    // Cinemeta catalog is keyed by IMDb; accept only an exact title and, when supplied,
    // a matching release year. A loosely similar title can show the wrong studio logo.
    const catalogType=type==="tv"?"series":"movie";
    const url="https://v3-cinemeta.strem.io/catalog/"+catalogType+"/top/search="+encodeURIComponent(title)+".json";
    const response=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{Accept:"application/json"}});
    if(!response.ok)throw Error("catalog search "+response.status);
    const data=await response.json();
    const target=normalizedMediaTitle(title);
    const candidates=(Array.isArray(data?.metas)?data.metas:[])
      .filter(x=>/^tt\d{7,10}$/i.test(String(x.id||""))&&normalizedMediaTitle(x.name)===target);
    const y=Number(year);
    const exactYear=Number.isInteger(y)&&y>1900
      ? candidates.filter(x=>Math.abs(Number(String(x.releaseInfo||x.year||x.released||"").slice(0,4))-y)<=1)
      : candidates;
    if(exactYear.length===1)resolvedId=exactYear[0].id;
    else if(!Number.isInteger(y)&&candidates.length===1)resolvedId=candidates[0].id;
  }
  if(!resolvedId)return null;
  // MetaHub provides existing transparent title logos (not generated or overlaid text).
  const logo="https://images.metahub.space/logo/medium/"+resolvedId+"/img";
  const check=await fetch(logo,{signal:AbortSignal.timeout(8000),headers:{Accept:"image/*"}});
  const contentType=check.headers.get("content-type")||"";
  if(!check.ok||!contentType.toLowerCase().startsWith("image/"))return null;
  await check.body?.cancel();
  return logo;
}
fastify.get("/api/tmdb/title-logo", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin","*");
  reply.header("Cross-Origin-Resource-Policy","cross-origin");
  reply.header("Cache-Control","public, max-age=3600");
  const type=String(request.query?.type||"");
  const id=String(request.query?.id||"");
  const title=String(request.query?.title||"").slice(0,160);
  const year=String(request.query?.year||"").slice(0,4);
  const imdbId=String(request.query?.imdb||"").slice(0,20);
  if(!["movie","tv"].includes(type)||!/^\d{1,12}$/.test(id))return reply.code(400).send({error:"invalid title"});
  const cacheKey=type+":"+id+":"+imdbId+":"+title+":"+year;
  const entry=tmdbLogoCache.get(cacheKey);
  if(entry&&entry.expires>Date.now())return entry.result;
  let logo=null,source="none";
  const token=process.env.TMDB_READ_TOKEN||process.env.TMDB_API_READ_ACCESS_TOKEN;
  const key=process.env.TMDB_API_KEY;
  if(token||key){
    try{
      const url=new URL("https://api.themoviedb.org/3/"+type+"/"+id+"/images");
      url.searchParams.set("include_image_language","en,null");
      if(!token)url.searchParams.set("api_key",key);
      const headers={Accept:"application/json"};
      if(token)headers.Authorization="Bearer "+token;
      const response=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});
      if(response.ok){
        const data=await response.json();
        const logos=(Array.isArray(data.logos)?data.logos:[]).filter(x=>x.file_path);
        logos.sort((a,b)=>(Number(b.iso_639_1==="en")-Number(a.iso_639_1==="en"))||((b.vote_average||0)-(a.vote_average||0)));
        if(logos.length){logo="https://image.tmdb.org/t/p/w500"+logos[0].file_path;source="tmdb"}
      }
    }catch(error){request.log.warn({error:String(error)},"tmdb logo lookup failed")}
  }
  if(!logo){
    try{
      logo=await findKeylessLogo({type,title,year,imdbId});
      if(logo)source="metahub";
    }catch(error){request.log.warn({error:String(error)},"keyless logo lookup failed")}
  }
  const result={logo,source,configured:Boolean(token||key)};
  tmdbLogoCache.set(cacheKey,{result,expires:Date.now()+(logo?86400000:1800000)});
  return result;
});


let arcadeGamesApiCache={data:null,expires:0};
fastify.get("/api/arcade-games",async(request,reply)=>{
 reply.header("Access-Control-Allow-Origin","*");
 reply.header("Cross-Origin-Resource-Policy","cross-origin");
 reply.header("Cache-Control","public,max-age=300");
 if(arcadeGamesApiCache.data&&Date.now()<arcadeGamesApiCache.expires)return arcadeGamesApiCache.data;
 const sources={
  tglsc:"https://glseries.net/api/cdn",
  seraph:"https://cdn.jsdelivr.net/gh/skibbsz/seraph@main/games.json",
  truffled:"https://cdn.jsdelivr.net/gh/susansigma/truffled.github.io@main/games.html"
 };
 const results=await Promise.allSettled(Object.entries(sources).map(async([name,url])=>{
  const response=await fetch(url,{signal:AbortSignal.timeout(10500),headers:{Accept:name==="truffled"?"text/html":"application/json", "User-Agent":"PacificArcade/1.0"}});
  if(!response.ok)throw Error(name+" HTTP "+response.status);
  const body=name==="truffled"?await response.text():await response.json();
  return [name,body];
 }));
 const data={};
 results.forEach((r,i)=>{if(r.status==="fulfilled")data[r.value[0]]=r.value[1];else request.log.warn({source:Object.keys(sources)[i],error:String(r.reason)},"game catalog failed")});
 if(!Object.keys(data).length){
  if(arcadeGamesApiCache.data)return arcadeGamesApiCache.data;
  return reply.code(503).send({error:"game catalog providers unavailable"});
 }
 const result={sources:data,updatedAt:new Date().toISOString()};
 arcadeGamesApiCache={data:result,expires:Date.now()+15*60*1000};
 return result;
});


let pacificTungGamesCache={games:null,expires:0};
fastify.get("/api/tungtung-games",async(request,reply)=>{
  reply.header("Access-Control-Allow-Origin","*");
  reply.header("Cross-Origin-Resource-Policy","cross-origin");
  reply.header("Cache-Control","public,max-age=300");
  if(pacificTungGamesCache.games&&pacificTungGamesCache.expires>Date.now())return {games:pacificTungGamesCache.games,source:"tungtung",cached:true};
  const origin="https://tungtung.baby";
  const catalogs=["tglsc.json","custom.json","gn-math.json","seraph.json"];
  const responses=await Promise.allSettled(catalogs.map(async filename=>{
    const response=await fetch(origin+"/"+filename,{signal:AbortSignal.timeout(9500),headers:{Accept:"application/json", "User-Agent":"Mozilla/5.0 PacificArcade/1.0"}});
    if(!response.ok)throw new Error(filename+" HTTP "+response.status);
    const data=await response.json();
    if(!Array.isArray(data))throw new Error(filename+" is not an array");
    return {filename,data};
  }));
  const results=[],seen=new Set(),errors=[];
  for(let i=0;i<responses.length;i++){
    const result=responses[i];
    if(result.status!=="fulfilled"){errors.push(catalogs[i]+": "+String(result.reason));continue}
    for(const row of result.value.data){
      if(!row||typeof row.name!=="string"||typeof row.url!=="string")continue;
      try{
        // The site's own catalog uses root-relative game and cover URLs.
        const url=new URL(row.url,origin);
        if(!["https:","http:"].includes(url.protocol))continue;
        const image=row.image?new URL(row.image,origin):null;
        const key=url.href;
        if(seen.has(key))continue;
        seen.add(key);
        results.push({name:row.name,url:key,image:image&&["https:","http:"].includes(image.protocol)?image.href:"",category:row.category||result.value.filename.replace(".json","")});
      }catch{}
    }
  }
  if(results.length){
    pacificTungGamesCache={games:results,expires:Date.now()+20*60*1000};
    return {games:results,source:"tungtung",count:results.length,partial:errors.length>0};
  }
  if(pacificTungGamesCache.games)return {games:pacificTungGamesCache.games,source:"tungtung",cached:true,stale:true};
  request.log.warn({errors},"tungtung catalogs unavailable");
  return reply.code(503).send({games:[],error:"Tungtung catalogs unavailable",sources:catalogs});
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
