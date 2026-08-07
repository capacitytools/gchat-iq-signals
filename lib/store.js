async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${process.env.DATA_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GH_PAT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gchat-engine",
      ...(options.headers || {})
    }
  });
  return res;
}

async function readJSON(file, fallback) {
  const res = await gh(`/contents/${file}`);
  if (res.status === 404) return { data: fallback, sha: null };
  if (!res.ok) throw new Error("read " + file + " " + res.status);
  const j = await res.json();
  return {
    data: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")),
    sha: j.sha
  };
}

async function writeJSON(file, obj, sha) {
  const body = {
    message: "update " + file,
    content: Buffer.from(JSON.stringify(obj)).toString("base64")
  };
  if (sha) body.sha = sha;

  let res = await gh(`/contents/${file}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (res.status === 409) {
    const cur = await readJSON(file, obj);
    body.sha = cur.sha;
    res = await gh(`/contents/${file}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) throw new Error("write " + file + " " + res.status);
}

module.exports = { readJSON, writeJSON };