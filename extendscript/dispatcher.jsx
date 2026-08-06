/**
 * MCP InDesign Agent — unique runtime dispatcher (ExtendScript / ES3).
 * Invoked via: do script … with arguments { requestPath, responsePath }
 *
 * Ops (phase 1): ping | scanDocument | noop
 */
#target "InDesign"

function mcpReadFile(path) {
  var f = new File(path);
  if (!f.exists) {
    throw new Error("Request file not found: " + path);
  }
  f.encoding = "UTF-8";
  f.open("r");
  var contents = f.read();
  f.close();
  return contents;
}

function mcpWriteFile(path, contents) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(contents);
  f.close();
}

function mcpParseJson(text) {
  if (typeof JSON !== "undefined" && JSON.parse) {
    return JSON.parse(text);
  }
  return eval("(" + text + ")");
}

function mcpStringify(value) {
  if (typeof JSON !== "undefined" && JSON.stringify) {
    return JSON.stringify(value);
  }
  return mcpStringifyFallback(value);
}

function mcpStringifyFallback(value) {
  if (value === null) return "null";
  var t = typeof value;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "string") {
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t") +
      '"'
    );
  }
  if (value instanceof Array) {
    var parts = [];
    for (var i = 0; i < value.length; i++) {
      parts.push(mcpStringifyFallback(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    var keys = [];
    for (var k in value) {
      if (value.hasOwnProperty(k) && typeof value[k] !== "undefined") {
        keys.push(mcpStringifyFallback(k) + ":" + mcpStringifyFallback(value[k]));
      }
    }
    return "{" + keys.join(",") + "}";
  }
  return "null";
}

function mcpSafePreview(text, maxLen) {
  if (!text) return "";
  var s = String(text).replace(/\s+/g, " ");
  if (s.length > maxLen) {
    return s.substring(0, maxLen);
  }
  return s;
}

function mcpBounds(item) {
  try {
    var b = item.geometricBounds; // [y1, x1, y2, x2]
    return {
      y1: b[0],
      x1: b[1],
      y2: b[2],
      x2: b[3],
    };
  } catch (e) {
    return null;
  }
}

function mcpItemType(item) {
  try {
    if (item instanceof TextFrame) return "TextFrame";
    if (item instanceof Rectangle) return "Rectangle";
    if (item instanceof Oval) return "Oval";
    if (item instanceof GraphicLine) return "GraphicLine";
    if (item instanceof Polygon) return "Polygon";
    if (item instanceof Group) return "Group";
  } catch (e) {
    /* ignore */
  }
  try {
    return String(item.reflect.name);
  } catch (e2) {
    return "PageItem";
  }
}

function mcpDocPath(d) {
  try {
    if (d.saved) {
      return String(d.fullName.fsName);
    }
  } catch (e) {
    /* unsaved or unavailable */
  }
  return null;
}

function mcpTextPreview(item) {
  try {
    if (item.hasOwnProperty("contents")) {
      return mcpSafePreview(item.contents, 120);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (item.texts && item.texts.length > 0) {
      return mcpSafePreview(item.texts[0].contents, 120);
    }
  } catch (e2) {
    /* ignore */
  }
  return "";
}

function opPing() {
  var doc = null;
  if (app.documents.length > 0) {
    var d = app.activeDocument;
    doc = {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
    };
  }
  return {
    op: "ping",
    appName: String(app.name),
    version: String(app.version),
    locale: String(app.locale),
    document: doc,
  };
}

function opNoop(cmd) {
  return {
    op: "noop",
    echo: cmd && cmd.echo !== undefined ? cmd.echo : null,
  };
}

function opScanDocument(cmd) {
  if (app.documents.length === 0) {
    throw new Error("NO_DOCUMENT: No active InDesign document. Open a .indd first.");
  }

  var depth = (cmd && cmd.depth) || "minimal";
  var d = app.activeDocument;
  var pageSize = null;
  try {
    var pb = d.documentPreferences;
    pageSize = {
      width: pb.pageWidth,
      height: pb.pageHeight,
    };
  } catch (e) {
    /* ignore */
  }

  var units = null;
  try {
    units = String(d.viewPreferences.horizontalMeasurementUnits);
  } catch (e2) {
    /* ignore */
  }

  var pages = [];
  var items = [];
  var pageLimit = d.pages.length;
  var i;
  var j;

  for (i = 0; i < pageLimit; i++) {
    var page = d.pages[i];
    pages.push({
      index: i,
      name: String(page.name),
    });

    if (depth === "none") {
      continue;
    }

    var pageItems = page.allPageItems;
    for (j = 0; j < pageItems.length; j++) {
      var it = pageItems[j];
      var entry = {
        pageIndex: i,
        itemIndex: j,
        type: mcpItemType(it),
        bounds: mcpBounds(it),
        label: "",
        textPreview: "",
      };
      try {
        entry.label = String(it.label || "");
      } catch (e3) {
        /* ignore */
      }
      entry.textPreview = mcpTextPreview(it);
      items.push(entry);
    }
  }

  return {
    op: "scanDocument",
    depth: depth,
    meta: {
      name: d.name,
      path: mcpDocPath(d),
      pageCount: d.pages.length,
      pageSize: pageSize,
      units: units,
    },
    pages: pages,
    items: items,
  };
}

function runCommand(cmd) {
  if (!cmd || !cmd.op) {
    throw new Error("Command missing op");
  }
  switch (String(cmd.op)) {
    case "ping":
      return opPing();
    case "noop":
      return opNoop(cmd);
    case "scanDocument":
      return opScanDocument(cmd);
    default:
      throw new Error("Unknown op: " + cmd.op);
  }
}

function mcpMain() {
  var requestPath = arguments[0];
  var responsePath = arguments[1];
  var result;

  try {
    if (!requestPath || !responsePath) {
      throw new Error("dispatcher requires requestPath and responsePath arguments");
    }

    var payload = mcpParseJson(mcpReadFile(requestPath));
    var commands = payload.commands || [];
    var results = [];
    var c;

    // Avoid modal dialogs blocking the bridge.
    var prevInteraction = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel =
      UserInteractionLevels.NEVER_INTERACT;

    try {
      for (c = 0; c < commands.length; c++) {
        results.push(runCommand(commands[c]));
      }
    } finally {
      app.scriptPreferences.userInteractionLevel = prevInteraction;
    }

    result = {
      ok: true,
      requestId: payload.requestId || null,
      results: results,
      modelPatch: null,
    };
  } catch (err) {
    var message = err && err.message ? String(err.message) : String(err);
    result = {
      ok: false,
      requestId: null,
      error: {
        message: message,
        name: err && err.name ? String(err.name) : "Error",
      },
      results: [],
      modelPatch: null,
    };
  }

  try {
    mcpWriteFile(responsePath, mcpStringify(result));
  } catch (writeErr) {
    // Last resort: cannot report via file.
    throw writeErr;
  }
}

mcpMain(arguments[0], arguments[1]);
