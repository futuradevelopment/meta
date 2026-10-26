# Meta — glasovni rezultati

Verzija 0.3.2: dva oblika mete — kružna i ovalna — s podesivim bodovnim rasponom za oba oblika. Automatski prijedlog i direktno podešavanje linija rade s odabranim brojem zona.

Web prototip za pasivno očitavanje vidljivih promjena na papirnoj meti. Kamera, obrada slike i glasovne objave rade u pregledniku na telefonu. Aplikacija nema backend niti šalje slike na server.

Zumiranje stranice gestama i slučajno označavanje teksta su isključeni. Stranica se i dalje može normalno pomicati, vrijednosti polja ostaju uređive, a klizač **Uvećanje** upravlja zumom kamere.

## Korištenje

1. Otvori aplikaciju preko HTTPS-a, npr. u Safariju na iPhoneu.
2. Za probu odaberi **Dodaj probni trag**. Demo slika prolazi kroz isti detektor promjena kao kamera.
3. Za stvarnu sliku odaberi **Uključi kameru**, dozvoli pristup i namjesti kadar.
4. Dodirni **Podesi linije** iznad kamere. U editoru odaberi **Kružna** ili **Ovalna**. Početni raspon je 10–1 za kružnu i 10–6 za ovalnu. U polju **Bodovni raspon** za oba oblika možeš odabrati raspon od 10–1 do 10–9, uključujući 10–7 (četiri linije) i 10–5 (šest linija).
5. Dodirni **Prepoznaj linije** za automatski prijedlog. Provjeri rezultat: dodirni crvenu liniju i povuci je da promijeniš veličinu. Centar pomjera cijeli raspored; bijele ručice podešavaju širinu, visinu i nagib. Tipke **− / +** služe za fine ispravke odabrane vrijednosti.
6. Dodirni **Primijeni**, pa **Pokreni praćenje**. Dostupni su glasovni rezultati, ručna potvrda očitanja, pregled serije i CSV izvoz.

Podešavanje se otvara preko cijelog ekrana, uz zadržanu sliku i pauzirano praćenje. Automatski prijedlog ne mijenja primijenjene linije dok ne potvrdiš **Primijeni**. **Odustani** vraća prethodni raspored. Ranije zabilježeni rezultati ostaju isti. Promjena bodovnog raspona zadržava centar, širinu, visinu i nagib, a novi broj linija početno raspoređuje ravnomjerno; zatim ih prepoznaj ili poravnaj ručno. Promjena oblika postavlja njegov početni raspon, dok **Vrati krugove** zadržava trenutno odabrani raspon. Razmaci pojedinačnih linija mogu se dodatno unijeti u **Razmaci linija**, unutar editora. U demo prikazu odabir oblika mijenja i simuliranu papirnu metu.

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

Testovi pokrivaju geometriju i bodovanje različitih oblika, detektor promjena, direktno uređivanje linija, automatsko prepoznavanje, potvrdu/otkazivanje prijedloga i kontrolu fokusa. Testiranje na stvarnom telefonu ostaje potrebno.

## Granice prototipa

- Bodovi su procjena prema centru detektovane promjene, a ne službeno bodovanje dodira ruba kruga.
- Detektor radi unutar podešene vanjske konture. Bodovi počinju od 10 i opadaju za jedan po liniji; odabrani raspon određuje broj linija za prikaz, prepoznavanje i bodovanje.
- Automatsko prepoznavanje traži koncentrične konture na uglavnom frontalnoj i dobro vidljivoj meti. Rezultat je prijedlog za ručnu provjeru; jaka perspektiva, odsječene linije, sjene ili oštećenja mogu spriječiti dobar prijedlog.
- Oval je prilagodljiv zaobljeni oblik sa zajedničkim centrom i proporcijama svih linija. To nije tačna rekonstrukcija proizvoljne štampane konture; zaobljenost i razmake treba provjeriti prema konkretnoj meti.
- Kamera, izbor objektiva i zum zavise od preglednika. Ako preglednik ne izloži zum kamere, koristi se digitalno uvećanje.
- Fokus na dodir zavisi od podrške preglednika i kamere. Prihvaćen zahtjev ne dokazuje da je slika postala oštra. Aplikacija ne pokreće kameru ponovo da bi simulirala fokusiranje.
- Glas zavisi od dostupnih glasova na telefonu. Prednost imaju bosanski, hrvatski i srpski glasovi, ako postoje.
- Praćenje se pauzira kada je stranica u pozadini. Novi trag kroz postojeću rupu bez vidljive promjene ne može se pouzdano očitati.
- Simulirani tragovi i detektor su testirani. Stvarna kamera, zum i glas na ciljnom iPhoneu još zahtijevaju provjeru.
