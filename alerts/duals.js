// Binary Stars: two players with a real connection on one card, a single 1-of-1 each (Sun rarity).
// "league|first player|second player|the connection". Only pairs where both players are on a current roster (or in the
// tennis top 100) become cards, so a retired or unsigned player simply drops the pair until he's back. A connection
// starting with @ says they're teammates now: if a trade splits them, the card reads "Former teammates" instead.
const RAW = `
mlb|Shohei Ohtani|Roki Sasaki|@Japan's Dodgers aces
mlb|Shohei Ohtani|Yoshinobu Yamamoto|@Dodgers teammates from Japan
mlb|Mookie Betts|Freddie Freeman|@Dodgers MVP teammates
mlb|Shohei Ohtani|Mookie Betts|@Dodgers MVPs
mlb|Mike Trout|Shohei Ohtani|Angels teammates, 2018 to 2023
mlb|Aaron Judge|Giancarlo Stanton|@Yankees home run pair
mlb|Aaron Judge|Juan Soto|The 2024 Yankees' slugging duo
mlb|Juan Soto|Francisco Lindor|@Mets stars
mlb|Pete Alonso|Francisco Lindor|Longtime Mets teammates
mlb|Bobby Witt Jr.|Salvador Perez|@Royals core
mlb|Vladimir Guerrero Jr.|Bo Bichette|Sons of big leaguers, longtime Blue Jays teammates
mlb|Fernando Tatis Jr.|Manny Machado|@Padres stars
mlb|Ronald Acuña Jr.|Ozzie Albies|@Braves core
mlb|Matt Olson|Austin Riley|@Braves corner infield
mlb|Corbin Carroll|Ketel Marte|@Diamondbacks stars
mlb|Gunnar Henderson|Adley Rutschman|Former Orioles teammates
mlb|Julio Rodríguez|Cal Raleigh|@Mariners stars
mlb|Paul Skenes|Tarik Skubal|Cy Young aces
mlb|Jose Altuve|Yordan Alvarez|Astros champions
mlb|Bryce Harper|Kyle Schwarber|@Phillies sluggers
mlb|Zack Wheeler|Aaron Nola|@Phillies rotation
mlb|Corey Seager|Marcus Semien|2023 champion Rangers middle infield
mlb|José Ramírez|Steven Kwan|@Guardians stars
mlb|Jackson Chourio|William Contreras|@Brewers core
mlb|Elly De La Cruz|Hunter Greene|@Reds stars
mlb|Wyatt Langford|Corey Seager|@Rangers bats
mlb|Freddie Freeman|Will Smith|Dodgers champions
nba|Giannis Antetokounmpo|Thanasis Antetokounmpo|Brothers
nba|LaMelo Ball|Lonzo Ball|Brothers
nba|Stephen Curry|Seth Curry|Brothers
nba|Jrue Holiday|Aaron Holiday|Brothers
nba|Franz Wagner|Moritz Wagner|Brothers
nba|Amen Thompson|Ausar Thompson|Twins
nba|LeBron James|Bronny James|Father and son
nba|Jayson Tatum|Jaylen Brown|Celtics champions
nba|Nikola Jokić|Jamal Murray|Nuggets champions
nba|Luka Dončić|LeBron James|Former Lakers teammates
nba|Luka Dončić|Kyrie Irving|The 2024 Finals backcourt
nba|LeBron James|Anthony Davis|2020 champions
nba|Stephen Curry|Draymond Green|Warriors dynasty
nba|Shai Gilgeous-Alexander|Jalen Williams|Thunder champions
nba|Shai Gilgeous-Alexander|Chet Holmgren|Thunder champions
nba|Victor Wembanyama|De'Aaron Fox|@Spurs stars
nba|Anthony Edwards|Rudy Gobert|@Timberwolves stars
nba|Jalen Brunson|Josh Hart|Villanova and Knicks
nba|Jalen Brunson|Mikal Bridges|Villanova champions and Knicks
nba|Jalen Brunson|Karl-Anthony Towns|@Knicks stars
nba|Tyrese Haliburton|Pascal Siakam|@Pacers stars
nba|Donovan Mitchell|Darius Garland|Former Cavaliers backcourt
nba|Donovan Mitchell|Evan Mobley|@Cavaliers stars
nba|Paolo Banchero|Franz Wagner|@Magic stars
nba|Joel Embiid|Tyrese Maxey|@76ers stars
nba|Cade Cunningham|Jalen Duren|@Pistons core
nba|Ja Morant|Jaren Jackson Jr.|Former Grizzlies core
nba|Trae Young|Jalen Johnson|Former Hawks teammates
nba|Kawhi Leonard|James Harden|Former Clippers stars
nba|Devin Booker|Bradley Beal|Former Suns backcourt
nba|Zion Williamson|Trey Murphy III|@Pelicans core
nba|Kevin Durant|Stephen Curry|2017 and 2018 champions
nba|Nikola Jokić|Luka Dončić|European superstars
nba|Giannis Antetokounmpo|Nikola Jokić|Back-to-back international MVPs
nfl|Patrick Mahomes|Travis Kelce|@Chiefs quarterback and tight end
nfl|Joe Burrow|Ja'Marr Chase|LSU champions and Bengals
nfl|Justin Jefferson|Ja'Marr Chase|LSU 2019 champions
nfl|Jalen Hurts|A.J. Brown|Eagles champions
nfl|Jalen Hurts|Saquon Barkley|Eagles champions
nfl|Lamar Jackson|Derrick Henry|@Ravens backfield
nfl|Nick Bosa|Joey Bosa|Brothers
nfl|Jared Goff|Amon-Ra St. Brown|@Lions connection
nfl|Jahmyr Gibbs|David Montgomery|Former Lions backfield
nfl|C.J. Stroud|Nico Collins|@Texans connection
nfl|Brock Purdy|Christian McCaffrey|@49ers stars
nfl|Jayden Daniels|Terry McLaurin|@Commanders connection
nfl|Josh Allen|James Cook|@Bills backfield
nfl|Matthew Stafford|Puka Nacua|@Rams connection
nfl|Dak Prescott|CeeDee Lamb|@Cowboys connection
nfl|Kyler Murray|Marvin Harrison Jr.|Former Cardinals connection
nfl|Travis Hunter|Shedeur Sanders|Colorado teammates
nfl|Caleb Williams|Jayden Daniels|The 2024 draft's top two
nfl|Bijan Robinson|Drake London|@Falcons stars
nfl|Justin Herbert|Ladd McConkey|@Chargers connection
nfl|Baker Mayfield|Mike Evans|Former Buccaneers connection
nfl|Jordan Love|Josh Jacobs|@Packers stars
nfl|T.J. Watt|Myles Garrett|The league's top pass rushers
nhl|Connor McDavid|Leon Draisaitl|@Oilers stars
nhl|Matthew Tkachuk|Brady Tkachuk|Brothers
nhl|Quinn Hughes|Jack Hughes|Brothers
nhl|Jack Hughes|Luke Hughes|Brothers
nhl|Sidney Crosby|Nathan MacKinnon|From Cole Harbour, Nova Scotia
nhl|Sidney Crosby|Evgeni Malkin|Penguins champions
nhl|Alex Ovechkin|Evgeni Malkin|Russian rivals
nhl|Auston Matthews|William Nylander|@Maple Leafs stars
nhl|Auston Matthews|Mitch Marner|Longtime Maple Leafs duo
nhl|Nikita Kucherov|Andrei Vasilevskiy|Lightning champions
nhl|Nathan MacKinnon|Cale Makar|Avalanche champions
nhl|Aleksander Barkov|Matthew Tkachuk|Panthers champions
nhl|Connor Bedard|Macklin Celebrini|Back-to-back first picks
nhl|Jack Eichel|Mark Stone|Golden Knights champions
nhl|Quinn Hughes|Elias Pettersson|Former Canucks core
nhl|David Pastrňák|Brad Marchand|Longtime Bruins duo
nhl|Kirill Kaprizov|Matt Boldy|@Wild stars
epl|Mohamed Salah|Virgil van Dijk|Liverpool champions
epl|Alexis Mac Allister|Dominik Szoboszlai|@Liverpool midfield
epl|Bukayo Saka|Martin Ødegaard|@Arsenal stars
epl|Declan Rice|Bukayo Saka|Arsenal and England
epl|Gabriel Martinelli|Gabriel Magalhães|Brazil and Arsenal
epl|Erling Haaland|Phil Foden|@Manchester City stars
epl|Rodri|Erling Haaland|Manchester City champions
epl|Bernardo Silva|Rúben Dias|Portugal and Manchester City
epl|Cole Palmer|Enzo Fernández|Former Chelsea teammates
epl|Bruno Fernandes|Kobbie Mainoo|@Manchester United core
epl|Bruno Guimarães|Anthony Gordon|@Newcastle stars
epl|Ollie Watkins|Emiliano Martínez|@Aston Villa stars
atp|Jannik Sinner|Carlos Alcaraz|Rivals
atp|Novak Djokovic|Carlos Alcaraz|Wimbledon final rivals
atp|Novak Djokovic|Jannik Sinner|Rivals
atp|Alexander Zverev|Jannik Sinner|Rivals
atp|Taylor Fritz|Tommy Paul|American rivals
atp|Holger Rune|Carlos Alcaraz|Rivals of the same generation
wta|Aryna Sabalenka|Iga Świątek|Rivals
wta|Coco Gauff|Jessica Pegula|American teammates
wta|Aryna Sabalenka|Coco Gauff|Rivals
wta|Iga Świątek|Coco Gauff|Rivals
wta|Elena Rybakina|Aryna Sabalenka|Rivals
`;
export const DUALS = RAW.trim().split("\n").map(l => { const [lg, a, b, c] = l.split("|"); return { lg, a, b, conn: c.replace(/^@/, ""), now: c.startsWith("@") }; });
