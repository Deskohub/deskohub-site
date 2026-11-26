import type { LegalSection } from "../../legal-document-body";
import { contactEmail } from "../operator-details";

export const unlimitedAutoRenewalSection: LegalSection = {
  heading: "16. Automatické obnovování členství Unlimited",
  body: [
    "16.1 Automatické obnovování si může zvolit pouze Klient, který si členství Unlimited kupuje pro sebe. Členství poskytuje sjednané služby v navazujících obdobích po 30 kalendářních dnech v časovém pásmu Europe/Prague. Smlouva při zvoleném obnovování trvá na dobu neurčitou bez dalšího minimálního závazku. Bez této volby přístup skončí s koncem zaplaceného období.",
    <>
      16.2 Aktuální ceny jsou uvedeny v{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href="/cs-CZ/pricing"
        hrefLang="cs-CZ"
      >
        ceníku
      </a>
      . Podle bodu 5.2 je pro každé obnovení závazná konečná částka uvedená v
      souhrnu objednávky bezprostředně před jejím odesláním, včetně zvolených
      pravidelných doplňků. Varianty s vyhrazeným místem mají kávu v ceně. Ke
      sdílenému místu lze kávu zvolit jako pravidelný doplněk. Akční nabídky,
      slevové kódy a slevy za doporučení platí pouze pro první období. Členství
      s prvním obdobím za nulovou cenu nelze automaticky obnovovat.
    </>,
    "16.3 První období Klient hradí při objednávce. Před jejím odesláním se mu zobrazí vybraná varianta a služby, první den přístupu, částka k úhradě, datum příští platby a částka za obnovení. Platba za obnovení připadá na začátek dalšího období v 00:00 pražského času. Například období od 1. prosince zahrnuje 1. až 30. prosince a další období začne 31. prosince.",
    "16.4 Klient povoluje budoucí platby z karty samostatným zaškrtávacím políčkem, které je ve výchozím stavu prázdné. Souhlas umožňuje Poskytovateli strhávat sjednanou částku každých 30 kalendářních dnů do zrušení obnovování. První karetní platba a případné ověření probíhají u Nexi. Poskytovatel použije pro další platby platební referenci. Potvrzení na trvalém nosiči obsahuje přijaté podmínky, udělený souhlas, částku, termíny a postup zrušení.",
    "16.5 Sedm kalendářních dnů před každou plánovanou platbou Poskytovatel pošle Klientovi e-mail s datem a částkou platby, dalším obdobím služby, lhůtou pro zrušení do 00:00 pražského času v den obnovení a přímým odkazem na správu obnovování. Jde o provozní zprávu, jejíž zasílání nezávisí na souhlasu s marketingem.",
    <>
      16.6 Klient může obnovování bezplatně zrušit v části Balíčky ve svém účtu
      nebo jednoznačným oznámením na{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . Aby neproběhla další platba, musí zrušení nastat před 00:00 pražského
      času (Europe/Prague) v plánovaný den obnovení. V účtu je zrušení účinné
      okamžikem odeslání; u e-mailu na {contactEmail} je rozhodující čas jeho
      doručení v časovém pásmu Europe/Prague. Pokud je včasné oznámení
      zpracováno až po zahájení platby za obnovení, Poskytovatel obnovené období
      zruší a tuto platbu vrátí v plné výši bez zbytečného odkladu. Poskytovatel
      zrušení potvrdí bez zbytečného odkladu, po zrušení už nezahájí žádnou
      další platbu za obnovení a přístup trvá do konce zaplaceného období.
    </>,
    "16.7 Poskytovatel před platbou zajistí kapacitu na celé další období. Pokud nemůže poskytnout sjednanou službu nebo konkrétní vyhrazené místo (Reserved Desk), požádá Klienta o souhlas s vhodnou alternativou nebo obnovování ukončí bez platby za další období. Jiná cena, změna pravidelného doplňku nebo podstatná změna služby vyžadují nový souhlas Klienta před platbou. Pokud si Klient pro sebe koupí další členství Unlimited, které pokrývá plánovaný den obnovení, původní členství se přestane obnovovat. Balíčky vstupů ani balíčky či členství koupené pro jinou osobu původní obnovování neukončí. Pokud přesto proběhne platba za obnovení původního členství, Poskytovatel duplicitní období zruší a platbu vrátí v plné výši bez zbytečného odkladu. Nové členství se obnovuje automaticky jen tehdy, když k tomu Klient při nákupu udělí samostatný souhlas.",
    "16.8 Pokud se platba za obnovení nezdaří, Poskytovatel Klienta vyrozumí a nabídne mu novou objednávku. Neúspěšnou platbu nebude automaticky opakovat. Bez úhrady dalšího období přístup skončí s koncem zaplaceného období.",
    "16.9 Právo Spotřebitele odstoupit od smlouvy se řídí článkem 9 a platnými právními předpisy. Vztahuje-li se na smlouvu zákonné právo na odstoupení, zahájení služby před uplynutím lhůty pro odstoupení vyžaduje samostatnou výslovnou žádost. Platným odstoupením podle zákona se automatické obnovování ukončí. Vrácení poměrné části ceny po zahájení služby upravuje bod 9.7.",
    "16.10 Při nákupu na firmu vystaví Poskytovatel za každé obnovení fakturu podle uložených fakturačních údajů. Aby se změna projevila na příští faktuře, Klient musí údaje upravit ve svém účtu před 00:00 pražského času v plánovaný den obnovení. Při výměně karty, včetně výměny kvůli končící platnosti, musí Klient zrušit obnovování a zadat novou objednávku s novou kartou.",
    <>
      16.11 Během zaplaceného období členství je sdílené místo (Open Space)
      dostupné denně od 00:00 do 17:00 pražského času a vyhrazené místo
      (Reserved Desk) nepřetržitě. Klient použije aktuální přístupový PIN, který
      se pravidelně mění. Na přiděleném vyhrazeném místě může Klient ponechat
      své věci přes noc, dokud trvá zaplacený přístup. Při skončení přístupu
      věci odnese, i když se obnovení nezdařilo. Pokud na místě něco zůstane,
      může si Klient domluvit vyzvednutí na adrese{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . Tím není dotčena povinnost Poskytovatele pečovat o věci s náležitou péčí
      v rozsahu stanoveném právními předpisy ani odpovědnost, kterou podle
      českého práva nelze vyloučit nebo omezit.
    </>,
  ],
};
