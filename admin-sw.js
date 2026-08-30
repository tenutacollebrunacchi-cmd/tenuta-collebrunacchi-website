// Service worker del solo pannello di gestione.
//
// Non mette NIENTE in cache di proposito: serve unicamente perche' Chrome
// consideri il pannello installabile come applicazione. Ogni richiesta va
// in rete come sempre, quindi dopo una pubblicazione non si rischia di
// aprire una versione vecchia, e nessun dato riservato resta sul telefono.
//
// L'ambito e' limitato a /admin.html: il sito pubblico non e' toccato.

self.addEventListener('install',  () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch',    () => { /* sempre rete, nessuna cache */ })
