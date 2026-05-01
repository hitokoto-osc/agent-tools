// Hostnames (and a small set of `host/path` prefixes) that the WebFetch tool
// treats as code-related documentation sites. Mirrored from claude-code's
// upstream list; kept in lockstep so behavior matches.

export const PREAPPROVED_HOSTS = new Set([
  // Anthropic
  "platform.claude.com",
  "code.claude.com",
  "modelcontextprotocol.io",
  "github.com/anthropics",
  "agentskills.io",

  // Top programming languages
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",

  // Web & JavaScript frameworks
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",

  // Python frameworks & libs
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",

  // PHP frameworks
  "laravel.com",
  "symfony.com",
  "wordpress.org",

  // Java frameworks & libs
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",

  // .NET / C#
  "asp.net",
  "dotnet.microsoft.com",
  "nuget.org",
  "blazor.net",

  // Mobile
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",

  // Data science / ML
  "keras.io",
  "spark.apache.org",
  "huggingface.co",
  "www.kaggle.com",

  // Databases
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",

  // Cloud & DevOps
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.netlify.com",
  "devcenter.heroku.com",

  // Testing
  "cypress.io",
  "selenium.dev",

  // Game dev
  "docs.unity.com",
  "docs.unrealengine.com",

  // Other essentials
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

// Split once at module load so lookups are O(1) for the common hostname-only
// case, falling back to a small per-host path-prefix list for path-scoped
// entries (e.g., "github.com/anthropics").
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      hosts.add(entry);
    } else {
      const host = entry.slice(0, slash);
      const path = entry.slice(slash);
      const prefixes = paths.get(host);
      if (prefixes) prefixes.push(path);
      else paths.set(host, [path]);
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (!prefixes) return false;
  // Enforce path segment boundaries so "/anthropics" doesn't match
  // "/anthropics-evil/...".
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
