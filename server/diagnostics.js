/**
 * Problèmes de configuration détectés au démarrage. Plutôt que de faire planter le serveur
 * (ce qui donne une erreur 503 opaque chez l'hébergeur), on les affiche sur une page d'aide.
 */
const problems = [];

function report(code, message, detail) {
  problems.push({ code, message });
  console.error(`[configuration] ${code} : ${message}${detail ? ' (' + detail + ')' : ''}`);
}

module.exports = { problems, report };
