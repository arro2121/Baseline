// Iconic Moments: the greatest moments in the history of the sports in Cosmic, in rank order. Each is a single 1-of-1 card.
// "Title|league|year|who|Wikipedia page (for reference; cards show no photos)"
export const MOMENTS_SRC = `Miracle on Ice|nhl|1980|Team USA beats the Soviet Union|Miracle on Ice
The Catch|nfl|1982|Montana to Clark|The Catch (American football)
Immaculate Reception|nfl|1972|Franco Harris|Immaculate Reception
Wilt's 100-Point Game|nba|1962|Wilt Chamberlain|Wilt Chamberlain's 100-point game
Shot Heard 'Round the World|mlb|1951|Bobby Thomson|Shot Heard 'Round the World (baseball)
Federer vs Nadal, Wimbledon|atp|2008|The greatest final ever played|2008 Wimbledon Championships – Men's singles final
The Flu Game|nba|1997|Michael Jordan|Flu Game
Kirk Gibson's Walk-Off|mlb|1988|World Series Game 1|Kirk Gibson's 1988 World Series home run
Kobe's 81|nba|2006|Kobe Bryant|Kobe Bryant's 81-point game
28-3 Comeback|nfl|2017|Super Bowl LI|Super Bowl LI
Leicester's 5000-1 Title|epl|2016|Leicester City champions|2015–16 Leicester City F.C. season
Battle of the Sexes|wta|1973|Billie Jean King|Battle of the Sexes (tennis)
The Block|nba|2016|LeBron James, NBA Finals Game 7|2016 NBA Finals
Don Larsen's Perfect Game|mlb|1956|World Series perfection|Don Larsen's perfect game
Music City Miracle|nfl|2000|Titans lateral|Music City Miracle
Agüerooooo|epl|2012|Title won at 93:20|2011–12 Manchester City F.C. season
Bobby Orr's Flying Goal|nhl|1970|Stanley Cup winner|1970 Stanley Cup Final
The Perfect Season|nfl|1972|Miami Dolphins 17-0|1972 Miami Dolphins season
Curse Reversed|mlb|2004|Red Sox beat the Yankees from 0-3|2004 American League Championship Series
Minneapolis Miracle|nfl|2018|Diggs to the end zone|Minneapolis Miracle
Golden Goal|nhl|2010|Sidney Crosby, Vancouver|Ice hockey at the 2010 Winter Olympics – Men's tournament
Serena Slam|wta|2003|Four majors in a row|Serena Slam
Cubs End the Drought|mlb|2016|World Series Game 7|2016 World Series
Philly Special|nfl|2018|Super Bowl LII|Philly Special
The Beast Quake|nfl|2011|Marshawn Lynch|Beast Quake
Isner vs Mahut|atp|2010|The 11-hour match|Isner–Mahut match at the 2010 Wimbledon Championships
Rangers End 54 Years|nhl|1994|Stanley Cup champions|1994 Stanley Cup Final
Tuck Rule Game|nfl|2002|Patriots in the snow|Tuck Rule Game
Joe Namath's Guarantee|nfl|1969|Super Bowl III|Super Bowl III
Malcolm Butler's Interception|nfl|2015|Super Bowl XLIX|Super Bowl XLIX
Djokovic vs Nadal, Melbourne|atp|2012|Five hours and 53 minutes|2012 Australian Open – Men's singles final
Game 6, 2011 World Series|mlb|2011|David Freese|2011 World Series
Ray Allen's Corner Three|nba|2013|NBA Finals Game 6|2013 NBA Finals
Mo Salah's 32|epl|2018|32 league goals in his first Liverpool season|2017–18 Liverpool F.C. season`;
export const MOMENTS = MOMENTS_SRC.split("\n").map((l, i) => { const [name, lg, year, who, wiki] = l.split("|"); return { rank: i + 1, name, lg, year, who, wiki: wiki || name }; });
