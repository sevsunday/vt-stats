(function () {
  "use strict";

  var FACTION_CODE = { ISDF: "i", Hadean: "e", Scion: "f" };
  var videos = [];

  function $(id) { return document.getElementById(id); }

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function params() {
    return new URLSearchParams(window.location.search);
  }

  function readFilters() {
    var q = params();
    return {
      q: q.get("q") || "",
      channel: q.get("ch") || "",
      commander: q.get("cmdr") || "",
      faction: q.get("faction") || "",
      map: q.get("map") || "",
      linked: q.get("linked") || ""
    };
  }

  function writeFilters(state) {
    var q = new URLSearchParams();
    if (state.q) q.set("q", state.q);
    if (state.channel) q.set("ch", state.channel);
    if (state.commander) q.set("cmdr", state.commander);
    if (state.faction) q.set("faction", state.faction);
    if (state.map) q.set("map", state.map);
    if (state.linked) q.set("linked", state.linked);
    var next = q.toString();
    var url = next ? ("?" + next) : window.location.pathname;
    history.replaceState(null, "", url);
  }

  function matchId(video) {
    return video.match && video.match.id ? video.match.id : "";
  }

  function commanders(video) {
    return Array.isArray(video.commanders) ? video.commanders : [];
  }

  function haystack(video) {
    var names = commanders(video).map(function (c) { return c.name || ""; });
    var map = video.map || {};
    return [
      video.title || "",
      video.description || "",
      names.join(" "),
      map.title || "",
      map.raw || ""
    ].join(" ").toLowerCase();
  }

  function passes(video, state) {
    if (state.q && haystack(video).indexOf(state.q.toLowerCase()) === -1) return false;
    var channel = (video.channel && video.channel.name) || "";
    if (state.channel && channel !== state.channel) return false;
    if (state.commander && !commanders(video).some(function (c) {
      return c.name === state.commander;
    })) return false;
    if (state.faction && !commanders(video).some(function (c) {
      return c.faction === state.faction;
    })) return false;
    var mapTitle = (video.map && (video.map.title || video.map.raw)) || "";
    if (state.map && mapTitle !== state.map) return false;
    var linked = !!matchId(video);
    if (state.linked === "yes" && !linked) return false;
    if (state.linked === "no" && linked) return false;
    return true;
  }

  function fillSelect(select, values, current, label) {
    var html = '<option value="">' + esc(label) + "</option>";
    values.forEach(function (value) {
      html += '<option value="' + esc(value) + '"' +
        (value === current ? " selected" : "") + ">" + esc(value) + "</option>";
    });
    select.innerHTML = html;
  }

  function unique(list) {
    var seen = {};
    var out = [];
    list.forEach(function (value) {
      if (!value || seen[value]) return;
      seen[value] = true;
      out.push(value);
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function personHtml(person) {
    var name = esc(person.name || "");
    if (!name) return "";
    var who = person.slug
      ? '<a href="../player/' + esc(person.slug) + '/">' + name + "</a>"
      : "<span>" + name + "</span>";
    var fac = FACTION_CODE[person.faction];
    var badge = fac
      ? '<span class="vt-faction-badge" data-faction-code="' + fac + '">' +
        esc(person.faction) + "</span>"
      : "";
    var trophy = person.winner
      ? '<i class="bi bi-trophy yt-winner" title="Winner" aria-label="Winner"></i>'
      : "";
    return '<span class="yt-person">' + who + badge + trophy + "</span>";
  }

  function peopleHtml(video) {
    var people = commanders(video).filter(function (person) { return person.name; });
    return people.map(function (person, index) {
      return (index ? '<span class="yt-vs">vs</span>' : "") + personHtml(person);
    }).join("");
  }

  function cardHtml(video) {
    var id = video.video_id || "";
    var title = video.title || id;
    var channel = video.channel || {};
    var map = video.map || {};
    var channelHtml = channel.url
      ? '<a href="' + esc(channel.url) + '" target="_blank" rel="noopener">' +
        esc(channel.name || "Channel") + "</a>"
      : esc(channel.name || "");
    var mapHtml = "";
    if (map.slug) {
      mapHtml = '<a href="../map/' + esc(map.slug) + '/">' +
        esc(map.title || map.raw) + "</a>";
    } else if (map.title || map.raw) {
      mapHtml = esc(map.title || map.raw);
    }
    var people = peopleHtml(video);
    var linked = matchId(video);
    var watch = linked
      ? '<a class="yt-action" href="../matches/?match=' + esc(linked) + '">' +
        '<i class="bi bi-clipboard-data" aria-hidden="true"></i>View match data</a>'
      : "";
    var when = video.recording_date || video.upload_date || "";
    return (
      '<div class="col-12 col-md-6 col-xl-4">' +
        '<article class="yt-card">' +
          '<a class="yt-thumb" href="' + esc(video.url || ("https://www.youtube.com/watch?v=" + id)) +
            '" target="_blank" rel="noopener">' +
            '<img src="https://i.ytimg.com/vi/' + esc(id) + '/hqdefault.jpg" alt="">' +
          "</a>" +
          '<div class="yt-card-body">' +
            '<a class="yt-title" href="' + esc(video.url || "#") +
              '" target="_blank" rel="noopener">' + esc(title) + "</a>" +
            '<div class="yt-meta">' + channelHtml +
              (when ? " · " + esc(when) : "") +
              (mapHtml ? " · " + mapHtml : "") +
            "</div>" +
            (people ? '<div class="yt-people">' + people + "</div>" : "") +
            '<div class="yt-actions">' +
              '<a class="yt-action" href="' + esc(video.url || "#") +
                '" target="_blank" rel="noopener">' +
                '<i class="bi bi-youtube" aria-hidden="true"></i>YouTube</a>' +
              watch +
            "</div>" +
          "</div>" +
        "</article>" +
      "</div>"
    );
  }

  function render() {
    var state = {
      q: $("yt-q").value.trim(),
      channel: $("yt-channel").value,
      commander: $("yt-commander").value,
      faction: $("yt-faction").value,
      map: $("yt-map").value,
      linked: $("yt-linked").value
    };
    writeFilters(state);
    var shown = videos.filter(function (video) { return passes(video, state); });
    $("yt-grid").innerHTML = shown.map(cardHtml).join("");
    $("yt-empty").classList.toggle("d-none", shown.length > 0);
    $("yt-count").textContent = shown.length + " of " + videos.length + " videos";
  }

  function bind() {
    ["yt-q", "yt-channel", "yt-commander", "yt-faction", "yt-map", "yt-linked"]
      .forEach(function (id) {
        $(id).addEventListener("input", render);
        $(id).addEventListener("change", render);
      });
  }

  function showEmpty(message) {
    videos = [];
    $("yt-grid").innerHTML = "";
    $("yt-empty").textContent = message;
    $("yt-empty").classList.remove("d-none");
    $("yt-count").textContent = message;
  }

  fetch("../data/external/youtube.json")
    .then(function (response) {
      if (!response.ok) throw new Error("missing");
      return response.json();
    })
    .then(function (data) {
      videos = Array.isArray(data.videos) ? data.videos : [];
      if (!videos.length) {
        showEmpty("No videos in the catalog yet.");
        return;
      }
      var state = readFilters();
      $("yt-q").value = state.q;
      fillSelect($("yt-channel"), unique(videos.map(function (v) {
        return v.channel && v.channel.name;
      })), state.channel, "Any");
      fillSelect($("yt-commander"), unique(videos.flatMap(function (v) {
        return commanders(v).map(function (c) { return c.name; });
      })), state.commander, "Any");
      fillSelect($("yt-faction"), unique(videos.flatMap(function (v) {
        return commanders(v).map(function (c) { return c.faction; });
      })), state.faction, "Any");
      fillSelect($("yt-map"), unique(videos.map(function (v) {
        return (v.map && (v.map.title || v.map.raw)) || "";
      })), state.map, "Any");
      $("yt-linked").value = state.linked;
      bind();
      render();
    })
    .catch(function () {
      showEmpty("The video catalog is not available yet.");
    });
}());
