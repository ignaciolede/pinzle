// Transporte de mensajes de una sala.
// - Con SUPABASE_URL/ANON_KEY en config.js -> Supabase Realtime (broadcast), online real.
// - Sin config -> BroadcastChannel (pestañas del mismo navegador), para probar rápido.
(function () {
  const hasSupabase = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY && window.supabase);
  const sb = hasSupabase ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;

  async function joinChannel(code, onMessage) {
    const name = "pinzle-" + code;

    if (sb) {
      const ch = sb.channel(name, { config: { broadcast: { self: false } } });
      ch.on("broadcast", { event: "m" }, ({ payload }) => onMessage(payload));
      await new Promise((res, rej) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED") res();
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") rej(new Error(status));
        });
      });
      return {
        send: (msg) => ch.send({ type: "broadcast", event: "m", payload: msg }),
        leave: () => sb.removeChannel(ch),
      };
    }

    const bc = new BroadcastChannel(name);
    bc.onmessage = (e) => onMessage(e.data);
    return {
      send: (msg) => bc.postMessage(msg),
      leave: () => bc.close(),
    };
  }

  window.Net = { joinChannel, sb, mode: hasSupabase ? "online" : "local" };
})();
