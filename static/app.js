// app.js (robust / defensive version)
const API = ""; // same-origin

/* ---------- helpers ---------- */
function showMessage(text, type = "error") {
  const el = document.getElementById("message");
  if (!el) {
    // fallback to alert for very broken pages
    alert(text);
    return;
  }
  el.textContent = text;
  el.classList.remove("error", "success");
  el.classList.add(type === "error" ? "error" : "success");
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function parseJSONSafe(res) {
  const txt = await res.text();
  try {
    return JSON.parse(txt || "{}");
  } catch {
    return { _raw: txt };
  }
}

function tokenHeader() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function safeFetch(url, opts = {}) {
  return fetch(`${API}${url}`, opts);
}

/* ---------- utility: safe element/get value ---------- */
function el(id) {
  return document.getElementById(id);
}
function valOf(...ids) {
  // return first non-empty element value; if element missing throw controlled error
  for (const id of ids) {
    const e = el(id);
    if (e) return e.value;
  }
  throw new Error(`Missing element(s): ${ids.join(" / ")}`);
}

/* ---------- auth: signup/login ---------- */
async function signup(username, password, formEl) {
  if (!username || !password) {
    showMessage("Username and password required", "error");
    return false;
  }
  try {
    const res = await safeFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Signup failed", "error");
      return false;
    }
    showMessage("Signup success — please login", "success");
    if (formEl && typeof formEl.reset === "function") formEl.reset();
    return true;
  } catch (e) {
    showMessage("Network error: " + (e.message || e), "error");
    return false;
  }
}

async function login(username, password, formEl) {
  if (!username || !password) {
    showMessage("Username and password required", "error");
    return false;
  }
  try {
    const res = await safeFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Login failed", "error");
      return false;
    }
    localStorage.setItem("token", data.access_token);
    if (formEl && typeof formEl.reset === "function") formEl.reset();
    showApp();
    await fetchPeople();
    return true;
  } catch (e) {
    showMessage("Network error: " + (e.message || e), "error");
    return false;
  }
}

/* ---------- CRUD ---------- */
// createPerson: accepts either a real formElement (with named inputs) or reads IDs directly.
// It tolerates both `name` and `p-name` and also `roll` / `p-roll`.
async function createPerson(formEl) {
  try {
    // Prefer reading from the provided form element's fields (if it's the real HTMLFormElement)
    let nameVal, rollVal, ageVal, genderVal;
    if (formEl && typeof formEl === "object" && typeof formEl.reset === "function") {
      // try multiple ways to fetch values safely
      try {
        nameVal = formEl.name ? formEl.name.value.trim() : (formEl.querySelector("#name, #p-name")?.value || "").trim();
      } catch {}
      try {
        rollVal = formEl.roll ? formEl.roll.value.trim() : (formEl.querySelector("#roll, #p-roll")?.value || "").trim();
      } catch {}
      try {
        ageVal = formEl.age ? formEl.age.value : (formEl.querySelector("#age, #p-age")?.value || "");
      } catch {}
      try {
        genderVal = formEl.gender ? formEl.gender.value : (formEl.querySelector("#gender, #p-gender")?.value || "");
      } catch {}
    }

    // fallback: grab by IDs (handles older or newer markup)
    nameVal = (nameVal || "").trim() || (el("name")?.value || "").trim() || (el("p-name")?.value || "").trim();
    rollVal = (rollVal || "").trim() || (el("roll")?.value || "").trim() || (el("p-roll")?.value || "").trim();
    ageVal = (ageVal !== undefined && ageVal !== null && String(ageVal) !== "") ? Number(ageVal) : (el("age")?.value || el("p-age")?.value || "");
    genderVal = (genderVal || "") || (el("gender")?.value || el("p-gender")?.value || "");

    if (!nameVal || !rollVal || genderVal === "" || ageVal === "" || Number.isNaN(Number(ageVal))) {
      showMessage("Please fill name, roll, age and gender correctly", "error");
      return;
    }

    const body = {
      name: nameVal,
      roll: rollVal,
      age: Number(ageVal),
      gender: genderVal,
    };

    const res = await safeFetch("/persons", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(body),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Create failed", "error");
      return;
    }
    showMessage("Person created", "success");
    if (formEl && typeof formEl.reset === "function") formEl.reset();
    await fetchPeople();
  } catch (e) {
    showMessage("Network error: " + (e.message || e), "error");
  }
}

async function fetchPeople(search = "") {
  try {
    const url = search ? `/persons?search=${encodeURIComponent(search)}` : "/persons";
    const res = await safeFetch(url, { headers: tokenHeader() });

    if (res.status === 401) {
      showMessage("Session expired", "error");
      logout();
      return;
    }

    const data = await parseJSONSafe(res);
    if (!res.ok) {
      showMessage(data.detail || data._raw || "Error fetching", "error");
      return;
    }
    renderPeople(data.items || []);
  } catch (e) {
    showMessage("Network error: " + (e.message || e), "error");
  }
}

function renderPeople(items) {
  const ul = el("people-list");
  if (!ul) {
    showMessage("Missing people-list element in DOM", "error");
    return;
  }
  ul.innerHTML = "";

  items.forEach((p) => {
    const apiId = p.user_person_id != null ? p.user_person_id : p.id;
    const displayId = p.user_person_id != null ? `${p.user_person_id} (user)` : p.id;

    const li = document.createElement("li");
    li.className = "person";
    li.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="small">[Roll: ${escapeHtml(p.roll)}]</span><br/>
        <span class="small">Age: ${escapeHtml(String(p.age))} • Gender: ${escapeHtml(p.gender)} • ID: ${escapeHtml(String(displayId))}</span>
      </div>
      <div class="actions">
        <button data-api-id="${apiId}" class="btn-edit">Edit</button>
        <button data-api-id="${apiId}" class="btn-delete">Delete</button>
      </div>
    `;
    ul.appendChild(li);
  });

  if (!ul._delegationAttached) {
    ul.addEventListener("click", delegatedClick);
    ul._delegationAttached = true;
  }
}

function delegatedClick(ev) {
  const editBtn = ev.target.closest(".btn-edit");
  if (editBtn) {
    onEdit({ currentTarget: editBtn });
    return;
  }
  const delBtn = ev.target.closest(".btn-delete");
  if (delBtn) {
    onDelete({ currentTarget: delBtn });
    return;
  }
}

async function onDelete(e) {
  const btn = e.currentTarget;
  const id = String(btn.dataset.apiId || "").trim();
  if (!id) {
    showMessage("Invalid id for delete", "error");
    return;
  }
  if (!confirm("Delete person id " + id + " ?")) return;

  const prevDisabled = btn.disabled;
  btn.disabled = true;
  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: tokenHeader(),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Delete failed", "error");
      return;
    }
    showMessage("Deleted", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + (err.message || err), "error");
  } finally {
    btn.disabled = prevDisabled;
  }
}

async function onEdit(e) {
  const btn = e.currentTarget;
  const id = String(btn.dataset.apiId || "").trim();
  if (!id) {
    showMessage("Invalid id for edit", "error");
    return;
  }
  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      headers: tokenHeader(),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "Fetch failed", "error");
      return;
    }
    // set edit-id to the API lookup id (user_person_id or id)
    const editIdEl = el("edit-id") || el("edit-id-hidden") || null;
    if (editIdEl) editIdEl.value = id;
    // populate fields (try multiple id variants)
    const setIfExists = (ids, value) => {
      for (const i of ids) {
        const ee = el(i);
        if (ee) {
          ee.value = value != null ? value : "";
          return;
        }
      }
    };
    setIfExists(["edit-name", "name"], data.name || "");
    setIfExists(["edit-roll", "roll"], data.roll || "");
    setIfExists(["edit-age", "age"], data.age != null ? data.age : "");
    setIfExists(["edit-gender", "gender"], data.gender || "");
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  } catch (err) {
    showMessage("Network error: " + (err.message || err), "error");
  }
}

async function putPerson() {
  const id = el("edit-id")?.value || el("edit-id-hidden")?.value || "";
  if (!id) {
    showMessage("No person selected for PUT", "error");
    return;
  }
  const payload = {
    name: el("edit-name")?.value?.trim() || el("name")?.value?.trim() || "",
    roll: el("edit-roll")?.value?.trim() || el("roll")?.value?.trim() || "",
    age: Number(el("edit-age")?.value ?? el("age")?.value ?? ""),
    gender: el("edit-gender")?.value || el("gender")?.value || "",
  };
  if (!payload.name || !payload.roll || payload.gender === "" || String(payload.age) === "NaN") {
    showMessage("Please provide all fields for PUT", "error");
    return;
  }

  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "PUT failed", "error");
      return;
    }
    showMessage("Person replaced", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + (err.message || err), "error");
  }
}

async function patchPerson() {
  const id = el("edit-id")?.value || el("edit-id-hidden")?.value || "";
  if (!id) {
    showMessage("No person selected for PATCH", "error");
    return;
  }
  const payload = {};
  const n = el("edit-name")?.value?.trim() || el("name")?.value?.trim() || "";
  const r = el("edit-roll")?.value?.trim() || el("roll")?.value?.trim() || "";
  const a = el("edit-age")?.value ?? el("age")?.value;
  const g = el("edit-gender")?.value || el("gender")?.value || "";

  if (n) payload.name = n;
  if (r) payload.roll = r;
  if (a !== "" && a !== undefined && a !== null) payload.age = Number(a);
  if (g) payload.gender = g;

  if (Object.keys(payload).length === 0) {
    showMessage("No fields provided for PATCH", "error");
    return;
  }

  try {
    const res = await safeFetch(`/persons/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: Object.assign({ "Content-Type": "application/json" }, tokenHeader()),
      body: JSON.stringify(payload),
    });
    const data = await parseJSONSafe(res);
    if (!res.ok) {
      if (res.status === 401) {
        showMessage("Session expired", "error");
        logout();
        return;
      }
      showMessage(data.detail || data._raw || "PATCH failed", "error");
      return;
    }
    showMessage("Person updated (partial)", "success");
    await fetchPeople();
  } catch (err) {
    showMessage("Network error: " + (err.message || err), "error");
  }
}

/* ---------- UI helpers ---------- */
function showApp() {
  el("auth")?.classList.add("hidden");
  el("app")?.classList.remove("hidden");
}
function showAuth() {
  el("app")?.classList.add("hidden");
  el("auth")?.classList.remove("hidden");
}
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ---------- startup wiring (defensive) ---------- */
document.addEventListener("DOMContentLoaded", () => {
  try {
    // initial view
    if (localStorage.getItem("token")) {
      showApp();
      fetchPeople();
    } else {
      showAuth();
    }

    // signup form
    const signupForm = el("signup-form");
    if (signupForm) {
      signupForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const u = el("signup-username")?.value?.trim() || el("signup-user")?.value?.trim() || "";
        const p = el("signup-password")?.value || "";
        signup(u, p, signupForm);
      });
    }

    // login form
    const loginForm = el("login-form");
    if (loginForm) {
      loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const u = el("login-username")?.value?.trim() || el("login-user")?.value?.trim() || "";
        const p = el("login-password")?.value || "";
        login(u, p, loginForm);
      });
    }

    // logout
    el("logout")?.addEventListener("click", logout);

    // create person
    const createForm = el("create-form");
    if (createForm) {
      createForm.addEventListener("submit", (e) => {
        e.preventDefault();
        createPerson(createForm);
      });
    } else {
      // support older markup where inputs are outside a form or use different ids
      const createBtn = el("create-btn") || el("add-person");
      if (createBtn) createBtn.addEventListener("click", () => createPerson(null));
    }

    // search button
    el("btn-search")?.addEventListener("click", () => {
      const q = (el("search")?.value || el("q")?.value || "").trim();
      fetchPeople(q);
    });

    // put/patch
    el("btn-put")?.addEventListener("click", putPerson);
    el("btn-patch")?.addEventListener("click", patchPerson);
  } catch (e) {
    // defensive fallback: show error to user
    showMessage("Startup error: " + (e.message || e), "error");
    console.error(e);
  }
});
