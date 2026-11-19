(() => {
  const form = document.getElementById("series-form");
  const button = form?.querySelector("[data-discord-preview-url]");
  if (!button) return;

  const preview = form.querySelector("[data-discord-preview]");
  const status = form.querySelector("[data-discord-preview-status]");
  const fields = preview.querySelector("[data-discord-preview-fields]");
  const draft = () => new URLSearchParams(new FormData(form)).toString();

  function setStatus(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  function hideStalePreview() {
    if (preview.hidden) return;
    preview.hidden = true;
    setStatus("Form changed. Refresh the preview to see the new values.");
  }

  form.addEventListener("input", hideStalePreview);
  form.addEventListener("change", hideStalePreview);

  button.addEventListener("click", async () => {
    if (!form.reportValidity()) return;
    const body = draft();
    button.disabled = true;
    preview.hidden = true;
    setStatus("Loading Discord post preview…");

    try {
      const response = await fetch(button.dataset.discordPreviewUrl, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      const data = await response.json().catch(() => null);
      if (draft() !== body) {
        setStatus("Form changed. Refresh the preview to see the new values.");
        return;
      }
      if (!response.ok || !data) throw new Error(data?.error || "Could not load the preview.");

      const { embed, channelIds, roleIds } = data;
      preview.querySelector("[data-discord-preview-title]").textContent = embed.title;
      preview.querySelector("[data-discord-preview-description]").textContent = embed.description;
      fields.replaceChildren();
      function addField(name, value) {
        const label = document.createElement("dt");
        const content = document.createElement("dd");
        label.textContent = name;
        content.textContent = value;
        fields.append(label, content);
      }
      for (const field of embed.fields) {
        const label = field.name.replace(/[\u200B\u2060\u2800]/g, "");
        if (!label) continue;
        const value = label === "Source" && embed.url ? embed.url : field.value;
        addField(label, value.replace(/^```text\n([\s\S]*)\n```$/, "$1"));
      }
      if (embed.thumbnail?.url) addField("Thumbnail URL", embed.thumbnail.url);

      preview.querySelector("[data-discord-preview-channels]").textContent = channelIds.join(", ") || "None configured";
      preview.querySelector("[data-discord-preview-roles]").textContent = roleIds.map(id => `<@&${id}>`).join(" ") || "None";
      preview.hidden = false;
      setStatus("Discord post preview ready.");
    } catch (error) {
      setStatus(error.message);
    } finally {
      button.disabled = false;
    }
  });
})();
