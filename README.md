# Meta — glasovni rezultati

Verzija 0.2.1: crveni krugovi i oznaka centra s tankim bijelim obrubom za jasniji prikaz preko papirne mete. Uključuje oporavak nakon stabilizacije slike i provjeru podrške za fokus na dodir iz verzije 0.2.

Web prototip za pasivno očitavanje vidljivih promjena na papirnoj meti. Kamera, obrada slike i glasovne objave rade u pregledniku na telefonu. Aplikacija nema backend niti šalje slike na server.

## Korištenje

1. Otvori aplikaciju preko HTTPS-a, npr. u Safariju na iPhoneu.
2. Za probu odaberi **Dodaj probni trag**. Demo slika prolazi kroz isti detektor promjena kao kamera.
3. Za stvarnu sliku odaberi **Uključi kameru**, dozvoli pristup i namjesti kadar.
4. Odaberi **Podesi metu**, označi centar i vanjski rub bodovnog kruga 1. Po potrebi prilagodi razmake krugova.
5. Odaberi **Pokreni praćenje**. Dostupni su glasovni rezultati, ručna potvrda očitanja, pregled serije i CSV izvoz.

Dok podešavanje krugova nije aktivno, dodir slike šalje zahtjev za fokus ako ga preglednik i odabrana kamera podržavaju. Dugme **Fokus u centru** radi istu radnju za centar kadra. Ako podrška ne postoji, aplikacija to jasno navodi i ne prikazuje lažnu potvrdu fokusiranja. Standardni Safari trenutno ne izlaže sve potrebne kontrole; fokusom tada upravlja kamera.

Sitna pomjeranja slike se poravnavaju s referentnim kadrom. Kod prolaznih smetnji praćenje ostaje uključeno i čeka stabilnu sliku. Nakon stabilne promjene osvjetljenja ili zamućenja može se automatski obnoviti referenca, bez bodovanja nejasnih promjena tokom smetnje. Nejasne višestruke promjene se ne boduju automatski. Veći trajni pomak kadra zahtijeva ponovno podešavanje mete; neprepoznate promjene scene mogu zahtijevati ručno obnavljanje reference.

Rezultati tekuće serije čuvaju se u memoriji preglednika. Osvježavanje stranice ili promjena izvora pokreće novu seriju; prije toga izvezi CSV ako želiš sačuvati rezultate.

## Cloudflare Pages + GitHub

U Cloudflare računu otvori **Workers & Pages → Create application → Pages → Connect to Git** i odaberi ovaj repozitorij.

| Postavka | Vrijednost |
| --- | --- |
| Production branch | `main` |
| Framework preset | `None` |
| Root directory | korijen repozitorija |
| Build command | `exit 0` |
| Build output directory | `dist` |

Nisu potrebne tajne, API ključevi ili varijable okruženja. Git integracija automatski objavljuje naredne promjene na grani `main`.

Cloudflare Pages web adresa je javna ako se zasebno ne uključi Cloudflare Access. Privatnost GitHub repozitorija sama po sebi ne ograničava pristup web aplikaciji.

Službena dokumentacija: [Static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/) · [GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/).

## Lokalni razvoj i provjera

Za desktop probu posluži sadržaj direktorija `dist/` na `localhost`; za telefon koristi HTTPS. Nema instalacijskih zavisnosti ni build koraka.

```sh
npm test
```

Testovi pokrivaju detektor promjena i kontrolu fokusa, uključujući ponašanje kada preglednik nema odgovarajuću podršku. Testiranje na stvarnom telefonu ostaje potrebno.

## Granice prototipa

- Bodovi su procjena prema centru detektovane promjene, a ne službeno bodovanje dodira ruba kruga.
- Detektor radi unutar podešenog vanjskog kruga; početnih deset krugova je jednako razmaknuto.
- Kamera, izbor objektiva i zum zavise od preglednika. Ako preglednik ne izloži zum kamere, koristi se digitalno uvećanje.
- Fokus na dodir zavisi od podrške preglednika i kamere. Prihvaćen zahtjev ne dokazuje da je slika postala oštra. Aplikacija ne pokreće kameru ponovo da bi simulirala fokusiranje.
- Glas zavisi od dostupnih glasova na telefonu. Prednost imaju bosanski, hrvatski i srpski glasovi, ako postoje.
- Praćenje se pauzira kada je stranica u pozadini. Novi trag kroz postojeću rupu bez vidljive promjene ne može se pouzdano očitati.
- Simulirani tragovi i detektor su testirani. Stvarna kamera, zum i glas na ciljnom iPhoneu još zahtijevaju provjeru.
