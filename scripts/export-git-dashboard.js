"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const out = path.join(__dirname, "..", "dashboard-full-from-git.html");
const buf = execSync("git show HEAD:dashboard.html", { cwd: path.join(__dirname, "..") });
fs.writeFileSync(out, buf);
console.log("wrote", out, buf.length, "bytes");
