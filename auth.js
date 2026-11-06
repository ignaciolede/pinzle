// Cuentas de usuario con Supabase Auth (email + contraseña) y perfil con estadísticas.
(function () {
  const sb = window.Net && Net.sb;
  let user = null, profile = null, listener = () => {};

  async function loadProfile() {
    if (!user) { profile = null; return; }
    const { data } = await sb.from("profiles").select("username, wins, rounds_played").eq("id", user.id).maybeSingle();
    profile = data || { username: (user.user_metadata && user.user_metadata.username) || "Jugador", wins: 0, rounds_played: 0 };
  }

  async function setUser(u) {
    user = u || null;
    await loadProfile();
    listener(profile);
  }

  function errMsg(e) {
    const m = (e && e.message) || "";
    if (/Invalid login/i.test(m)) return "Email o contraseña incorrectos";
    if (/already registered/i.test(m)) return "Ese email ya tiene cuenta";
    if (/Password should be/i.test(m)) return "La contraseña debe tener al menos 6 caracteres";
    if (/Email not confirmed/i.test(m)) return "Confirmá tu email antes de ingresar";
    if (/rate limit/i.test(m)) return "Demasiados intentos, esperá un momento";
    return m || "Error";
  }

  const Auth = {
    enabled: !!sb,
    get profile() { return profile; },

    async init(onChange) {
      listener = onChange;
      if (!sb) return onChange(null);
      const { data } = await sb.auth.getSession();
      await setUser(data.session && data.session.user);
      sb.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT") setUser(session && session.user);
      });
    },

    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(errMsg(error));
    },

    async signUp(username, email, password) {
      username = username.trim();
      if (username.length < 2) throw new Error("El usuario debe tener al menos 2 letras");
      const { data: taken } = await sb.from("profiles").select("id").ilike("username", username).maybeSingle();
      if (taken) throw new Error("Ese nombre de usuario ya existe");
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw new Error(errMsg(error));
      return { needsConfirm: !data.session };
    },

    async signOut() { await sb.auth.signOut(); },

    async recordRound(won) {
      if (!sb || !user) return;
      const { error } = await sb.rpc("record_round", { won });
      if (!error) { await loadProfile(); listener(profile); }
    },
  };

  window.Auth = Auth;
})();
