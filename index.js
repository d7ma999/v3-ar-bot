// V3-AR — بوت موسيقى بواجهة عربية (discord.js v14 + distube)
// يدعم: YouTube, SoundCloud, Spotify
// Node.js 18+  |  npm i discord.js @distube/distube @distube/yt-dlp @distube/soundcloud @distube/spotify dotenv

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} from "discord.js";
import { DisTube } from "@distube/distube";
import { YtDlpPlugin } from "@distube/yt-dlp";
import { SoundCloudPlugin } from "@distube/soundcloud";
import { SpotifyPlugin } from "@distube/spotify";

// ─── TOKEN ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_TOKEN || fs.readFileSync(path.join(__dirname, "token.txt"), "utf8").trim();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const REPEAT_NAMES = ["إيقاف", "أغنية", "الطابور"];
const FILTERS = {
  off: { label: "بدون فلتر", filter: null },
  bass: { label: "تعزيز الباس", filter: "bass=g=12" },
  night: { label: "نايتكور", filter: "asetrate=44100*1.25,aresample=44100" },
  slow: { label: "بطيء", filter: "asetrate=44100*0.85,aresample=44100" },
};
const FILTER_ORDER = Object.keys(FILTERS);

// ─── PLAYLISTS PERSISTENCE ───────────────────────────────────────────────────
const PLAYLISTS_PATH = path.join(__dirname, "playlists.json");
let PLAYLISTS = {};
if (fs.existsSync(PLAYLISTS_PATH)) {
  try { PLAYLISTS = JSON.parse(fs.readFileSync(PLAYLISTS_PATH, "utf8")); } catch { }
}
function savePlaylists() {
  fs.writeFileSync(PLAYLISTS_PATH, JSON.stringify(PLAYLISTS, null, 2), "utf8");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmt(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// ─── GUILD STATE ─────────────────────────────────────────────────────────────
// DisTube manages the queue; we store extra per-guild UI state here
const guildState = new Map(); // guildId → { msg, filterKey, volume, requesterMap }
function getState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, { msg: null, filterKey: "off", volume: 50, requesterMap: new Map() });
  }
  return guildState.get(guildId);
}

// ─── CLIENT + DISTUBE ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const distube = new DisTube(client, {
  plugins: [
    new YtDlpPlugin({ update: false, ytdlpArgs: ["--cookies", "./www.youtube.com_cookies.txt"] }),
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
  ],
  ffmpegPath: "ffmpeg",
  emitNewSongOnly: true,
});

// ─── EMBED BUILDER ───────────────────────────────────────────────────────────
function buildEmbed(song, queue, state) {
  if (!song) {
    return new EmbedBuilder()
      .setTitle("⏹ انتهى التشغيل")
      .setDescription("استخدم /play لإضافة أغنية.")
      .setColor(0x2b2d31);
  }
  const by = state.requesterMap.get(song.id || song.name) || "-";
  const repeat = queue?.repeatMode ?? 0;
  const vol = state.volume;
  const filterLabel = FILTERS[state.filterKey].label;

  return new EmbedBuilder()
    .setTitle("🎶 يتم التشغيل الآن")
    .setDescription(`[${song.name}](${song.url})\nبواسطة **${song.uploader?.name || song.member?.user?.tag || "-"}**`)
    .addFields(
      { name: "المدة", value: `\`${fmt(song.duration)}\``, inline: true },
      { name: "طلب من", value: by, inline: true },
      { name: "في الطابور", value: String(queue?.songs?.length ? queue.songs.length - 1 : 0), inline: true }
    )
    .setFooter({ text: `الصوت: ${vol}% · التكرار: ${REPEAT_NAMES[repeat]} · الفلتر: ${filterLabel}` })
    .setThumbnail(song.thumbnail || null)
    .setColor(0x5865f2);
}

// ─── CONTROLS VIEW ───────────────────────────────────────────────────────────
function buildControls(queue) {
  const paused = queue?.paused ?? false;

  const row0 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pause").setEmoji(paused ? "▶️" : "⏸").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("prev").setEmoji("⏮").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("skip").setEmoji("⏭").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("loop").setEmoji(["🔁", "🔂", "🔁"][queue?.repeatMode ?? 0])
      .setStyle(queue?.repeatMode ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("shuffle").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("vol_down").setEmoji("🔉").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("vol_up").setEmoji("🔊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("stop").setEmoji("⏹").setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("more")
      .setPlaceholder("المزيد من الميزات…")
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel("الطابور").setValue("queue").setEmoji("📜"),
        new StringSelectMenuOptionBuilder().setLabel("السجل").setValue("history").setEmoji("🕘"),
        new StringSelectMenuOptionBuilder().setLabel("تقديم 10 ثواني").setValue("fwd").setEmoji("⏩"),
        new StringSelectMenuOptionBuilder().setLabel("ترجيع 10 ثواني").setValue("back").setEmoji("⏪"),
        new StringSelectMenuOptionBuilder().setLabel("الفلاتر").setValue("filter").setEmoji("🎛️"),
        new StringSelectMenuOptionBuilder().setLabel("مسح الطابور").setValue("clear").setEmoji("🧹"),
        new StringSelectMenuOptionBuilder().setLabel("فصل البوت").setValue("leave").setEmoji("🔌"),
      )
  );

  return [row0, row1, row2];
}

// ─── PANEL SEND / REFRESH ────────────────────────────────────────────────────
async function sendPanel(channel, song, queue, state) {
  if (state.msg) {
    try { await state.msg.delete(); } catch { }
    state.msg = null;
  }
  state.msg = await channel.send({
    embeds: [buildEmbed(song, queue, state)],
    components: buildControls(queue),
  });
}

async function refreshPanel(song, queue, state) {
  if (!state.msg) return;
  try {
    await state.msg.edit({
      embeds: [buildEmbed(song, queue, state)],
      components: buildControls(queue),
    });
  } catch { }
}

// ─── DISTUBE EVENTS ──────────────────────────────────────────────────────────
distube.on("playSong", async (queue, song) => {
  const state = getState(queue.id);
  await sendPanel(queue.textChannel, song, queue, state);
});

distube.on("addSong", async (queue, song) => {
  const state = getState(queue.id);
  await refreshPanel(queue.songs[0], queue, state);
});

distube.on("finish", async (queue) => {
  const state = getState(queue.id);
  if (state.msg) {
    try {
      await state.msg.edit({ embeds: [buildEmbed(null, null, state)], components: [] });
    } catch { }
    state.msg = null;
  }
});

distube.on("error", (channel, error) => {
  console.error("DisTube error:", error);
  channel?.send?.(`❌ خطأ: \`${String(error).slice(0, 200)}\``);
});

// ─── INTERACTION HANDLER ─────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── SLASH COMMANDS ─────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName, guild, member, channel } = interaction;

    if (commandName === "play") {
      const query = interaction.options.getString("input");
      if (!member.voice?.channel)
        return interaction.reply({ content: "ادخل روم صوتي أول.", ephemeral: true });
      await interaction.deferReply();
      try {
        const state = getState(guild.id);
        // store requester by song name; distube fires addSong before we know the id
        distube.once("addSong", (_, song) => {
          state.requesterMap.set(song.id || song.name, member.toString());
        });
        await distube.play(member.voice.channel, query, {
          textChannel: channel,
          member,
        });
        await interaction.deleteReply().catch(() => { });
      } catch (e) {
        await interaction.followUp({ content: `❌ ما لقيت شي: \`${String(e).slice(0, 200)}\`` });
      }
      return;
    }

    if (commandName === "queue") {
      const queue = distube.getQueue(guild);
      if (!queue?.songs?.length)
        return interaction.reply({ content: "الطابور فاضي.", ephemeral: true });
      const lines = queue.songs.slice(1, 16).map((s, i) => `${i + 1}. ${s.name} \`${fmt(s.duration)}\``);
      return interaction.reply({ content: lines.join("\n") || "بس أغنية وحدة.", ephemeral: true });
    }

    if (commandName === "skip") {
      const queue = distube.getQueue(guild);
      if (!queue) return interaction.reply({ content: "ما فيه شي يشتغل.", ephemeral: true });
      await distube.skip(guild);
      return interaction.reply({ content: "⏭ تم التخطي" });
    }

    if (commandName === "stop") {
      const queue = distube.getQueue(guild);
      if (queue) distube.stop(guild);
      const state = getState(guild.id);
      if (state.msg) {
        try { await state.msg.edit({ embeds: [buildEmbed(null, null, state)], components: [] }); } catch { }
        state.msg = null;
      }
      return interaction.reply({ content: "⏹ تم الإيقاف" });
    }

    // ── PLAYLIST SUBCOMMANDS ─────────────────────────────────────────────────
    if (commandName === "playlist") {
      const sub = interaction.options.getSubcommand();
      const gid = guild.id;

      if (sub === "save") {
        const name = interaction.options.getString("name");
        const queue = distube.getQueue(guild);
        if (!queue?.songs?.length)
          return interaction.reply({ content: "ماكو شي بالطابور.", ephemeral: true });
        PLAYLISTS[gid] ??= {};
        PLAYLISTS[gid][name] = queue.songs.map((s) => ({
          title: s.name, url: s.url, duration: s.duration,
          thumb: s.thumbnail, artist: s.uploader?.name || "-",
        }));
        savePlaylists();
        return interaction.reply({ content: `✅ تم حفظ **${queue.songs.length}** أغنية بقائمة **${name}**` });
      }

      if (sub === "add") {
        const name = interaction.options.getString("name");
        const song = interaction.options.getString("song");
        await interaction.deferReply({ ephemeral: true });
        try {
          // resolve metadata without joining vc — use yt-dlp via distube search
          const [result] = await distube.search(song, { limit: 1 });
          PLAYLISTS[gid] ??= {};
          PLAYLISTS[gid][name] ??= [];
          PLAYLISTS[gid][name].push({
            title: result.name, url: result.url, duration: result.duration,
            thumb: result.thumbnail, artist: result.uploader?.name || "-",
          });
          savePlaylists();
          await interaction.followUp({ content: `✅ أضفت **${result.name}** لقائمة **${name}**`, ephemeral: true });
        } catch (e) {
          await interaction.followUp({ content: `❌ ما لقيت شي: \`${String(e).slice(0, 200)}\``, ephemeral: true });
        }
        return;
      }

      if (sub === "play") {
        const name = interaction.options.getString("name");
        const saved = PLAYLISTS[gid]?.[name];
        if (!saved?.length)
          return interaction.reply({ content: "ماكو قائمة بهذا الاسم.", ephemeral: true });
        if (!member.voice?.channel)
          return interaction.reply({ content: "ادخل روم صوتي أول.", ephemeral: true });
        await interaction.deferReply();
        for (const t of saved) {
          await distube.play(member.voice.channel, t.url, { textChannel: channel, member }).catch(() => { });
        }
        await interaction.followUp({ content: `✅ أضفت **${saved.length}** أغنية من قائمة **${name}** للطابور` });
        return;
      }

      if (sub === "list") {
        const pls = PLAYLISTS[gid] || {};
        if (!Object.keys(pls).length)
          return interaction.reply({ content: "ماكو قوائم محفوظة.", ephemeral: true });
        const lines = Object.entries(pls).map(([n, s]) => `📀 **${n}** — ${s.length} أغنية`);
        return interaction.reply({ content: lines.join("\n"), ephemeral: true });
      }

      if (sub === "show") {
        const name = interaction.options.getString("name");
        const saved = PLAYLISTS[gid]?.[name];
        if (!saved)
          return interaction.reply({ content: "ماكو قائمة بهذا الاسم.", ephemeral: true });
        const lines = saved.slice(0, 20).map((t, i) => `${i + 1}. ${t.title} \`${fmt(t.duration)}\``);
        return interaction.reply({ content: `📀 **${name}**\n${lines.join("\n")}`, ephemeral: true });
      }

      if (sub === "delete") {
        const name = interaction.options.getString("name");
        if (PLAYLISTS[gid]?.[name]) {
          delete PLAYLISTS[gid][name];
          savePlaylists();
          return interaction.reply({ content: `🗑 تم حذف قائمة **${name}**`, ephemeral: true });
        }
        return interaction.reply({ content: "ماكو قائمة بهذا الاسم.", ephemeral: true });
      }
    }
    return;
  }

  // ── BUTTONS ────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const { guild, member, customId } = interaction;
    const queue = distube.getQueue(guild);
    const state = getState(guild.id);

    // voice check
    if (!member.voice?.channel || (queue && member.voice.channel.id !== queue.voice?.channel?.id)) {
      return interaction.reply({ content: "لازم تكون معي في نفس الروم الصوتي.", ephemeral: true });
    }

    if (customId === "pause") {
      if (!queue) return interaction.deferUpdate();
      queue.paused ? await distube.resume(guild) : await distube.pause(guild);
      await interaction.update({ embeds: [buildEmbed(queue.songs[0], queue, state)], components: buildControls(queue) });
      return;
    }

    if (customId === "skip") {
      if (!queue) return interaction.deferUpdate();
      await interaction.deferUpdate();
      await distube.skip(guild);
      return;
    }

    if (customId === "prev") {
      if (!queue) return interaction.deferUpdate();
      await interaction.deferUpdate();
      try { await distube.previous(guild); } catch {
        await interaction.followUp({ content: "ما فيه أغنية سابقة.", ephemeral: true });
      }
      return;
    }

    if (customId === "loop") {
      if (!queue) return interaction.deferUpdate();
      const next = (queue.repeatMode + 1) % 3;
      distube.setRepeatMode(guild, next);
      await interaction.update({ embeds: [buildEmbed(queue.songs[0], queue, state)], components: buildControls(queue) });
      return;
    }

    if (customId === "shuffle") {
      if (!queue) return interaction.deferUpdate();
      distube.shuffle(guild);
      await interaction.update({ embeds: [buildEmbed(queue.songs[0], queue, state)], components: buildControls(queue) });
      return;
    }

    if (customId === "vol_down" || customId === "vol_up") {
      if (!queue) return interaction.deferUpdate();
      state.volume = Math.min(100, Math.max(0, state.volume + (customId === "vol_up" ? 10 : -10)));
      distube.setVolume(guild, state.volume);
      await interaction.update({ embeds: [buildEmbed(queue.songs[0], queue, state)], components: buildControls(queue) });
      return;
    }

    if (customId === "stop") {
      if (queue) distube.stop(guild);
      if (state.msg) {
        try { await state.msg.edit({ embeds: [buildEmbed(null, null, state)], components: [] }); } catch { }
        state.msg = null;
      }
      await interaction.deferUpdate();
      return;
    }
  }

  // ── SELECT MENU ────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "more") {
    const { guild, member } = interaction;
    const queue = distube.getQueue(guild);
    const state = getState(guild.id);
    const val = interaction.values[0];

    // voice check (except info-only)
    const needsVoice = ["fwd", "back", "filter", "clear", "leave"].includes(val);
    if (needsVoice && (!member.voice?.channel || (queue && member.voice.channel.id !== queue.voice?.channel?.id))) {
      return interaction.reply({ content: "لازم تكون معي في نفس الروم الصوتي.", ephemeral: true });
    }

    if (val === "queue") {
      const lines = queue?.songs?.slice(1, 16).map((s, i) => `${i + 1}. ${s.name} \`${fmt(s.duration)}\``) || [];
      return interaction.reply({ content: lines.join("\n") || "الطابور فاضي.", ephemeral: true });
    }

    if (val === "history") {
      const hist = distube.getQueue(guild)?.previousSongs?.slice(-10).reverse() || [];
      const lines = hist.map((s) => `• ${s.name}`);
      return interaction.reply({ content: lines.join("\n") || "ما فيه سجل.", ephemeral: true });
    }

    if (val === "fwd" || val === "back") {
      if (!queue) return interaction.deferUpdate();
      await interaction.deferUpdate();
      const delta = val === "fwd" ? 10 : -10;
      const newPos = Math.max(0, queue.currentTime + delta);
      await distube.seek(guild, newPos);
      await refreshPanel(queue.songs[0], queue, state);
      return;
    }

    if (val === "filter") {
      if (!queue) return interaction.deferUpdate();
      await interaction.deferUpdate();
      const idx = (FILTER_ORDER.indexOf(state.filterKey) + 1) % FILTER_ORDER.length;
      state.filterKey = FILTER_ORDER[idx];
      const flt = FILTERS[state.filterKey].filter;
      distube.setFilter(guild, flt ? { [state.filterKey]: flt } : false);
      await refreshPanel(queue.songs[0], queue, state);
      return;
    }

    if (val === "clear") {
      if (queue) distube.getQueue(guild).songs.splice(1);
      await interaction.update({ embeds: [buildEmbed(queue?.songs[0], queue, state)], components: buildControls(queue) });
      return;
    }

    if (val === "leave") {
      if (queue) distube.stop(guild);
      await interaction.deferUpdate();
      if (state.msg) {
        try { await state.msg.edit({ content: "تم فصل البوت 👋", embeds: [], components: [] }); } catch { }
        state.msg = null;
      }
      return;
    }
  }
});

// ─── REGISTER COMMANDS ────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("play").setDescription("شغّل أغنية (يوتيوب / ساوند كلاود / سبوتفاي / اسم)")
    .addStringOption((o) => o.setName("input").setDescription("رابط أو اسم الأغنية").setRequired(true)),
  new SlashCommandBuilder().setName("queue").setDescription("اعرض الطابور"),
  new SlashCommandBuilder().setName("skip").setDescription("تخطي الأغنية"),
  new SlashCommandBuilder().setName("stop").setDescription("إيقاف ومسح الطابور"),
  new SlashCommandBuilder()
    .setName("playlist").setDescription("إدارة قوائم التشغيل المحفوظة")
    .addSubcommand((s) => s.setName("save").setDescription("احفظ الطابور الحالي").addStringOption((o) => o.setName("name").setDescription("اسم القائمة").setRequired(true)))
    .addSubcommand((s) => s.setName("add").setDescription("ضيف أغنية لقائمة").addStringOption((o) => o.setName("name").setDescription("اسم القائمة").setRequired(true)).addStringOption((o) => o.setName("song").setDescription("رابط أو اسم الأغنية").setRequired(true)))
    .addSubcommand((s) => s.setName("play").setDescription("شغّل قائمة محفوظة").addStringOption((o) => o.setName("name").setDescription("اسم القائمة").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("اعرض القوائم المحفوظة"))
    .addSubcommand((s) => s.setName("show").setDescription("اعرض أغاني قائمة").addStringOption((o) => o.setName("name").setDescription("اسم القائمة").setRequired(true)))
    .addSubcommand((s) => s.setName("delete").setDescription("احذف قائمة").addStringOption((o) => o.setName("name").setDescription("اسم القائمة").setRequired(true))),
].map((c) => c.toJSON());

client.once("ready", async () => {
  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log(`جاهز: ${client.user.tag}`);
});

client.login(TOKEN);
