'use strict';

/* ── Supabase client (init แบบปลอดภัย — ไม่ให้ crash ถ้า SDK ยังไม่โหลด) ── */
let supabaseClient = null;

function initSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  if (!window.supabase?.createClient) {
    console.error('Supabase SDK ไม่โหลด — ตรวจสอบอินเทอร์เน็ตหรือ CDN');
    return null;
  }
  if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
    console.error('ไม่พบ supabase-config.js');
    return null;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabaseClient;
}

const Auth = {
  SESSION_KEY: 'kls_session',

  _db() {
    const client = initSupabaseClient();
    if (!client) return { ok: false, msg: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองรีเฟรชหน้า' };
    return { ok: true, client };
  },

  _saveLocalSession(session) {
    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
  },

  _sessionFromRpc(data) {
    return { id: data.id, username: data.username, guest: false };
  },

  _rpcError(error) {
    const msg = error?.message || '';
    const code = error?.code || '';
    if (code === 'PGRST202' || msg.includes('404') || msg.includes('register_player') || msg.includes('Could not find the function')) {
      return 'ยังไม่ได้ตั้งค่า Database — เปิด Supabase → SQL Editor แล้วรันไฟล์ supabase-schema.sql';
    }
    return msg || 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ';
  },

  async register(username, password) {
    const name = username.trim();
    if (name.length < 2) return { ok: false, msg: 'ชื่อผู้ใช้ต้องมีอย่างน้อย 2 ตัวอักษร' };
    if (password.length < 4) return { ok: false, msg: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัว' };

    const db = this._db();
    if (!db.ok) return db;

    const { data, error } = await db.client.rpc('register_player', {
      p_username: name,
      p_password: password,
    });

    if (error) {
      const msg = this._rpcError(error);
      if (msg.includes('gen_salt') || msg.includes('42883')) {
        return { ok: false, msg: 'Database ยังตั้งค่าไม่ครบ — รัน supabase-fix-functions.sql ใน Supabase SQL Editor' };
      }
      return { ok: false, msg };
    }
    if (!data?.ok) return { ok: false, msg: data.msg || 'สมัครไม่สำเร็จ' };

    const session = this._sessionFromRpc(data);
    this._saveLocalSession(session);
    return { ok: true, session };
  },

  async login(username, password) {
    const name = username.trim();
    if (!name) return { ok: false, msg: 'กรุณากรอกชื่อผู้ใช้' };

    const db = this._db();
    if (!db.ok) return db;

    const { data, error } = await db.client.rpc('login_player', {
      p_username: name,
      p_password: password,
    });

    if (error) {
      const msg = this._rpcError(error);
      if (msg.includes('gen_salt') || msg.includes('42883')) {
        return { ok: false, msg: 'Database ยังตั้งค่าไม่ครบ — รัน supabase-fix-functions.sql ใน Supabase SQL Editor' };
      }
      return { ok: false, msg };
    }
    if (!data?.ok) return { ok: false, msg: data.msg || 'เข้าสู่ระบบไม่สำเร็จ' };

    const session = this._sessionFromRpc(data);
    this._saveLocalSession(session);
    return { ok: true, session };
  },

  guest() {
    const n = 'Guest' + Math.floor(Math.random() * 9000 + 1000);
    const session = { username: n, id: 'g_' + Date.now(), guest: true };
    this._saveLocalSession(session);
    return { ok: true, session };
  },

  current() {
    try { return JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null'); }
    catch { return null; }
  },

  async restoreSession() {
    const local = this.current();
    if (!local) return null;

    // Guest ไม่เก็บ session ข้าม refresh
    if (local.guest) {
      localStorage.removeItem(this.SESSION_KEY);
      return null;
    }

    // ไม่มี DB ชั่วคราว — ใช้ session ในเครื่องต่อ
    const db = this._db();
    if (!db.ok) return local;

    const { data, error } = await db.client.rpc('verify_player', { p_player_id: local.id });

    if (error) {
      console.warn('verify_player failed, using cached session');
      return local;
    }

    if (!data?.ok) {
      localStorage.removeItem(this.SESSION_KEY);
      return null;
    }

    const session = { id: local.id, username: data.username, guest: false };
    this._saveLocalSession(session);
    return session;
  },

  async logout() {
    localStorage.removeItem(this.SESSION_KEY);
  },

  isLoggedIn() {
    const s = this.current();
    return !!(s && !s.guest);
  },

  async saveScore({ score, wave, kills, timeSeconds, result, mode }) {
    const session = this.current();
    if (!session || session.guest) return { ok: false, msg: 'guest' };

    const db = this._db();
    if (!db.ok) return db;

    const { data, error } = await db.client.rpc('save_player_score', {
      p_player_id: session.id,
      p_score: Math.max(0, Math.floor(score)),
      p_wave: Math.max(0, Math.floor(wave || 0)),
      p_kills: Math.max(0, Math.floor(kills || 0)),
      p_time_seconds: Math.max(0, Math.floor(timeSeconds || 0)),
      p_result: result === 'victory' ? 'victory' : 'defeat',
      p_mode: mode || 'solo',
    });

    if (error) {
      const msg = this._rpcError(error);
      if (msg.includes('gen_salt') || msg.includes('42883')) {
        return { ok: false, msg: 'Database ยังตั้งค่าไม่ครบ — รัน supabase-fix-functions.sql ใน Supabase SQL Editor' };
      }
      return { ok: false, msg };
    }
    if (!data?.ok) return { ok: false, msg: data.msg || 'บันทึกคะแนนไม่สำเร็จ' };
    return { ok: true };
  },

  _LEADERBOARD_RPC_KEY: 'kls_leaderboard_rpc_ok',

  async getLeaderboard(limit = 5) {
    const db = this._db();
    if (!db.ok) return { ok: false, rows: [], msg: db.msg };

    const cap = Math.max(1, Math.min(limit, 50));
    const rpcKnownMissing = sessionStorage.getItem(this._LEADERBOARD_RPC_KEY) === '0';

    if (!rpcKnownMissing) {
      const { data, error } = await db.client.rpc('get_leaderboard', { p_limit: cap });
      if (!error) {
        sessionStorage.setItem(this._LEADERBOARD_RPC_KEY, '1');
        return { ok: true, rows: data || [] };
      }

      const missingRpc = error.code === 'PGRST202'
        || error.status === 404
        || (error.message || '').includes('get_leaderboard')
        || (error.message || '').includes('Could not find the function');
      if (missingRpc) {
        sessionStorage.setItem(this._LEADERBOARD_RPC_KEY, '0');
        return this._getLeaderboardFallback(cap);
      }

      return { ok: false, rows: [], msg: error.message };
    }

    return this._getLeaderboardFallback(cap);
  },

  async _getLeaderboardFallback(limit) {
    const db = this._db();
    if (!db.ok) return { ok: false, rows: [], msg: db.msg };

    const { data, error } = await db.client
      .from('scores')
      .select('player_id, username, score, time_seconds');

    if (error) return { ok: false, rows: [], msg: error.message };

    const byPlayer = new Map();
    (data || []).forEach(row => {
      const key = row.player_id;
      if (!key) return;
      const cur = byPlayer.get(key) || {
        username: row.username,
        total_score: 0,
        total_time_seconds: 0,
        play_count: 0,
      };
      cur.total_score += Number(row.score) || 0;
      cur.total_time_seconds += Number(row.time_seconds) || 0;
      cur.play_count += 1;
      cur.username = row.username;
      byPlayer.set(key, cur);
    });

    const rows = [...byPlayer.values()]
      .sort((a, b) => b.total_score - a.total_score || b.total_time_seconds - a.total_time_seconds)
      .slice(0, limit);

    return { ok: true, rows };
  },
};

/* ── Multiplayer Lobby (localStorage + BroadcastChannel) ── */
const Lobby = {
  ROOMS_KEY: 'kls_rooms',
  roomCode: null,
  playerId: null,
  isHost: false,
  channel: null,
  players: [],
  onUpdate: null,

  _rooms() {
    try { return JSON.parse(localStorage.getItem(this.ROOMS_KEY) || '{}'); }
    catch { return {}; }
  },

  _saveRooms(r) { localStorage.setItem(this.ROOMS_KEY, JSON.stringify(r)); },

  _code() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  },

  _notify() { if (this.onUpdate) this.onUpdate(); },

  createRoom() {
    const session = Auth.current();
    if (!session) return { ok: false, msg: 'กรุณาเข้าสู่ระบบก่อน' };
    const rooms = this._rooms();
    let code;
    do { code = this._code(); } while (rooms[code]);
    this.roomCode = code;
    this.playerId = session.id;
    this.isHost = true;
    this.players = [{ id: session.id, name: session.username, host: true }];
    rooms[code] = { host: session.id, players: this.players, created: Date.now() };
    this._saveRooms(rooms);
    this._connect();
    return { ok: true, code };
  },

  joinRoom(code) {
    const session = Auth.current();
    if (!session) return { ok: false, msg: 'กรุณาเข้าสู่ระบบก่อน' };
    code = code.trim().toUpperCase();
    const rooms = this._rooms();
    const room = rooms[code];
    if (!room) return { ok: false, msg: 'ไม่พบห้องนี้' };
    if (room.players.length >= 4) return { ok: false, msg: 'ห้องเต็มแล้ว (สูงสุด 4 คน)' };
    if (room.players.some(p => p.id === session.id))
      return { ok: false, msg: 'คุณอยู่ในห้องนี้แล้ว' };
    room.players.push({ id: session.id, name: session.username, host: false });
    rooms[code] = room;
    this._saveRooms(rooms);
    this.roomCode = code;
    this.playerId = session.id;
    this.isHost = room.host === session.id;
    this.players = room.players;
    this._connect();
    this._broadcast({ type: 'join', player: { id: session.id, name: session.username } });
    return { ok: true, code };
  },

  leaveRoom() {
    if (!this.roomCode) return;
    const rooms = this._rooms();
    const room = rooms[this.roomCode];
    if (room) {
      room.players = room.players.filter(p => p.id !== this.playerId);
      if (room.players.length === 0) delete rooms[this.roomCode];
      else {
        if (room.host === this.playerId && room.players.length) {
          room.host = room.players[0].id;
          room.players[0].host = true;
        }
        rooms[this.roomCode] = room;
      }
      this._saveRooms(rooms);
      this._broadcast({ type: 'leave', id: this.playerId });
    }
    if (this.channel) { this.channel.close(); this.channel = null; }
    this.roomCode = null;
    this.players = [];
    this.isHost = false;
    this._notify();
  },

  refresh() {
    if (!this.roomCode) return;
    const room = this._rooms()[this.roomCode];
    if (room) {
      this.players = room.players;
      this.isHost = room.host === this.playerId;
    }
    this._notify();
  },

  _connect() {
    if (this.channel) this.channel.close();
    this.channel = new BroadcastChannel('kls-room-' + this.roomCode);
    this.channel.onmessage = (e) => this._onMsg(e.data);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => this.refresh(), 1500);
    this._notify();
  },

  _onMsg(data) {
    if (data.type === 'start' && !this.isHost) {
      if (window.onLobbyStart) window.onLobbyStart(data.mode || 'multi');
    }
    if (data.type === 'join' || data.type === 'leave') this.refresh();
  },

  _broadcast(data) { this.channel && this.channel.postMessage(data); },

  startGame() {
    if (!this.isHost) return false;
    this._broadcast({ type: 'start', mode: 'multi' });
    return true;
  },

  getCoopNames() {
    const me = Auth.current();
    return this.players.filter(p => p.id !== me?.id).map(p => p.name);
  },
};

window.Auth = Auth;
window.Lobby = Lobby;
