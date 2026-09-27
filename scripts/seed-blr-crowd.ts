import type { PrismaClient, connection_intent } from "@prisma/client"
import { deriveInterestedIn, type Gender, type Orientation } from "../lib/dating"
import { expertiseFor } from "../lib/expertise"
import PORTRAITS from "./seed-blr-portraits.json"

/**
 * The people who fill the Bengaluru scenario events — the avatars in "who's
 * going", the faces on the room grid, the ratings under a past event.
 *
 * A card that says "3 going" next to three QA accounts tests the layout for
 * three. The interesting layouts are 30 avatars overflowing into "+27", a room
 * of 36 with some revealed and some blurred, and a past event with a dozen
 * reviews — none of which exist without a crowd.
 *
 * These accounts **cannot sign in**: no password, on a `.invalid` domain
 * (RFC 2606), so nobody can receive mail for them and nobody will mistake them
 * for a real person's account. Testers sign in as the seed-qa attendees and
 * look at these people.
 *
 * Every profile column the app reads is filled with something coherent for
 * that person — a UX designer's expertise is design expertise, a 24-year-old
 * did not graduate in 2005, `interested_in` is derived the way the server
 * derives it. Photos are real portraits (Unsplash CDN, verified to serve the
 * phone's loader); `blur_photo` is the same picture through the CDN's blur,
 * which is what an unrevealed profile shows.
 */

export const CROWD_DOMAIN = "crowd.blendn.invalid"

interface Person {
  first: string
  last: string
  gender: "woman" | "man"
  age: number
  occupation: string
  field: string
  education: string
  area: string
  bio: string
  interests: string[]
  goals: string[]
  lookingFor: string[]
  intents: connection_intent[]
  orientations: Orientation[]
}

const W = "woman" as const
const M = "man" as const

/* Twenty-four women, twenty-four men, 21–42 (every one clears the 21+ events). */
const PEOPLE: Person[] = [
  { first: "Aishwarya", last: "Hegde", gender: W, age: 27, occupation: "Product Designer at Swiggy", field: "design", education: "NID Bengaluru", area: "Indiranagar", bio: "Designing checkout flows by day, pottery wheel by weekend. Always up for a gallery walk.", interests: ["Design", "Pottery", "Live music"], goals: ["Meet other designers", "Find a pottery buddy"], lookingFor: ["Creative collaborators", "Friends"], intents: ["friendship", "networking"], orientations: ["straight"] },
  { first: "Meera", last: "Krishnan", gender: W, age: 31, occupation: "Engineering Manager at Flipkart", field: "software", education: "BITS Pilani", area: "Koramangala", bio: "Managing twelve engineers and one very opinionated cat. Carnatic violin since I was seven.", interests: ["Carnatic music", "Leadership", "Running"], goals: ["Swap notes with other EMs"], lookingFor: ["Mentors", "Peers"], intents: ["networking"], orientations: ["straight"] },
  { first: "Priya", last: "Venkatesh", gender: W, age: 25, occupation: "Data Analyst at PhonePe", field: "data_ai", education: "Christ University", area: "HSR Layout", bio: "SQL, board games and very strong filter coffee. New-ish to Bengaluru — show me your favourite darshini.", interests: ["Board games", "Coffee", "Data"], goals: ["Make friends in the city"], lookingFor: ["Friends", "Game night regulars"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Divya", last: "Rao", gender: W, age: 29, occupation: "Architect at Mistry Architects", field: "design", education: "RV College of Architecture", area: "Jayanagar", bio: "Old Bangalore bungalows are my love language. I sketch buildings on napkins.", interests: ["Architecture", "Heritage walks", "Sketching"], goals: ["Find a sketching group"], lookingFor: ["Friends", "Creative collaborators"], intents: ["friendship", "dating"], orientations: ["straight"] },
  { first: "Sanjana", last: "Iyer", gender: W, age: 23, occupation: "MBA student at IIM Bangalore", field: "student", education: "IIM Bangalore", area: "Bannerghatta Road", bio: "Case competitions, badminton and hunting for the best dosa in town.", interests: ["Startups", "Badminton", "Food"], goals: ["Meet founders", "Summer internship"], lookingFor: ["Mentors", "Friends"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Kritika", last: "Sharma", gender: W, age: 34, occupation: "Founder, Kindred Health", field: "healthcare", education: "AIIMS Delhi", area: "Whitefield", bio: "Doctor turned founder building primary care that actually listens. Weekend cyclist.", interests: ["Healthtech", "Cycling", "Startups"], goals: ["Hire a founding engineer"], lookingFor: ["Co-founders", "Engineers"], intents: ["networking"], orientations: ["straight"] },
  { first: "Nandini", last: "Gowda", gender: W, age: 28, occupation: "Chef de Partie at Farmlore", field: "hospitality", education: "IHM Bengaluru", area: "Malleshwaram", bio: "I cook with Malnad ingredients and I will talk your ear off about fermentation.", interests: ["Food", "Fermentation", "Supper clubs"], goals: ["Start a supper club"], lookingFor: ["Food people", "Friends"], intents: ["friendship", "dating"], orientations: ["bisexual"] },
  { first: "Ritika", last: "Menon", gender: W, age: 26, occupation: "Content Strategist at Zeta", field: "marketing", education: "Mount Carmel College", area: "Domlur", bio: "Words for a living, techno for fun. Probably at Kitty Ko on a Friday.", interests: ["Techno", "Writing", "Film"], goals: ["Find people to go dancing with"], lookingFor: ["Friends", "Dates"], intents: ["dating", "friendship"], orientations: ["straight"] },
  { first: "Anjali", last: "Pillai", gender: W, age: 30, occupation: "Corporate Lawyer at Trilegal", field: "law_policy", education: "NLSIU Bengaluru", area: "Richmond Town", bio: "Contracts by day, open mics by night (as audience, mostly).", interests: ["Comedy", "Books", "Wine"], goals: ["Read more fiction"], lookingFor: ["Book club", "Friends"], intents: ["friendship"], orientations: ["straight"] },
  { first: "Shreya", last: "Bhat", gender: W, age: 24, occupation: "Frontend Engineer at Razorpay", field: "software", education: "PES University", area: "Banashankari", bio: "React, rock climbing and too many houseplants.", interests: ["Climbing", "Plants", "Tech meetups"], goals: ["Give my first tech talk"], lookingFor: ["Mentors", "Climbing partners"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Lakshmi", last: "Narayan", gender: W, age: 38, occupation: "Principal Scientist at Biocon", field: "healthcare", education: "IISc Bangalore", area: "Electronic City", bio: "Biologics researcher, marathoner, amateur birder at Hesaraghatta.", interests: ["Running", "Birding", "Science"], goals: ["Run a sub-4 marathon"], lookingFor: ["Running buddies"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Fatima", last: "Sheikh", gender: W, age: 29, occupation: "UX Researcher at Atlassian", field: "design", education: "Srishti Institute", area: "Frazer Town", bio: "I ask people why, for a living. Frazer Town food walks are my thing.", interests: ["Research", "Food walks", "Photography"], goals: ["Start a research meetup"], lookingFor: ["Collaborators", "Friends"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Pooja", last: "Reddy", gender: W, age: 32, occupation: "Investment Associate at Accel", field: "finance", education: "ISB Hyderabad", area: "Sadashivanagar", bio: "Investing in consumer brands. Ask me about D2C, or better, about Carnatic fusion.", interests: ["Startups", "Music", "Yoga"], goals: ["Meet early founders"], lookingFor: ["Founders"], intents: ["networking"], orientations: ["straight"] },
  { first: "Tanvi", last: "Kulkarni", gender: W, age: 22, occupation: "Illustrator (freelance)", field: "arts", education: "Chitrakala Parishath", area: "Basavanagudi", bio: "I draw cats, temples and cats in temples. Commissions open.", interests: ["Illustration", "Art fairs", "Cats"], goals: ["Sell at a flea market"], lookingFor: ["Artists", "Friends"], intents: ["friendship"], orientations: ["queer"] },
  { first: "Aditi", last: "Joshi", gender: W, age: 35, occupation: "Head of Operations at Dunzo", field: "operations", education: "Symbiosis Pune", area: "Hebbal", bio: "Logistics nerd. Weekends are for long rides to Nandi Hills.", interests: ["Cycling", "Operations", "Travel"], goals: ["Ride a 200 km brevet"], lookingFor: ["Riding group"], intents: ["friendship", "networking"], orientations: ["straight"] },
  { first: "Zoya", last: "Khan", gender: W, age: 27, occupation: "Journalist at The News Minute", field: "media", education: "Asian College of Journalism", area: "Cooke Town", bio: "I write about cities and the people who run them. Tip line always open.", interests: ["Civic tech", "Books", "Cities"], goals: ["Cover the civic hackathon"], lookingFor: ["Sources", "Friends"], intents: ["networking", "just_here"], orientations: ["straight"] },
  { first: "Kavitha", last: "Suresh", gender: W, age: 41, occupation: "Yoga teacher & physiotherapist", field: "healthcare", education: "Manipal University", area: "Cubbon Park area", bio: "Twenty years of teaching bodies to move kindly. Morning person, unapologetically.", interests: ["Yoga", "Meditation", "Wellness"], goals: ["Grow the community class"], lookingFor: ["Students", "Friends"], intents: ["just_here", "friendship"], orientations: ["straight"] },
  { first: "Ishita", last: "Banerjee", gender: W, age: 26, occupation: "ML Engineer at Sarvam AI", field: "data_ai", education: "IIT Kharagpur", area: "Koramangala", bio: "Training models for Indian languages. Will debate evals over beer.", interests: ["AI", "Craft beer", "Quizzing"], goals: ["Speak at a meetup"], lookingFor: ["Peers", "Dates"], intents: ["networking", "dating"], orientations: ["straight"] },
  { first: "Neha", last: "Agarwal", gender: W, age: 30, occupation: "Brand Manager at Blue Tokai", field: "marketing", education: "MICA Ahmedabad", area: "Indiranagar", bio: "Coffee is literally my job. Yes, I have opinions on your pour-over.", interests: ["Coffee", "Branding", "Brunch"], goals: ["Host more cuppings"], lookingFor: ["Coffee people", "Friends"], intents: ["friendship", "networking"], orientations: ["straight"] },
  { first: "Roshni", last: "D'Souza", gender: W, age: 33, occupation: "Music teacher & jazz vocalist", field: "arts", education: "Bangalore School of Music", area: "Frazer Town", bio: "I sing standards at brunches and teach piano to very patient eight-year-olds.", interests: ["Jazz", "Piano", "Brunch"], goals: ["Record an EP"], lookingFor: ["Musicians", "Friends"], intents: ["friendship", "dating"], orientations: ["straight"] },
  { first: "Swati", last: "Mishra", gender: W, age: 28, occupation: "Policy Analyst at Janaagraha", field: "government_ngo", education: "TISS Mumbai", area: "Vasanth Nagar", bio: "Ward budgets and bus routes. Trying to make Bengaluru a little more walkable.", interests: ["Civic tech", "Walking", "Policy"], goals: ["Map every footpath in my ward"], lookingFor: ["Civic hackers", "Friends"], intents: ["networking", "friendship"], orientations: ["lesbian"] },
  { first: "Harini", last: "Subramanian", gender: W, age: 24, occupation: "Associate Consultant at McKinsey", field: "consulting", education: "St. Joseph's College", area: "Ulsoor", bio: "Slides by day, Sunday runs around Ulsoor lake.", interests: ["Running", "Travel", "Food"], goals: ["Finish a half marathon"], lookingFor: ["Running buddies", "Dates"], intents: ["dating", "friendship"], orientations: ["straight"] },
  { first: "Madhuri", last: "Patil", gender: W, age: 36, occupation: "Teacher at Inventure Academy", field: "education", education: "Azim Premji University", area: "Sarjapur Road", bio: "Middle-school science teacher and weekend potter.", interests: ["Pottery", "Science", "Gardening"], goals: ["Throw a full dinner set"], lookingFor: ["Makers", "Friends"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Smriti", last: "Kamath", gender: W, age: 29, occupation: "Product Manager at Meesho", field: "product", education: "NIT Surathkal", area: "Bellandur", bio: "Shipping things for Bharat. Karaoke is where I'm most myself.", interests: ["Product", "Karaoke", "Board games"], goals: ["Meet other PMs"], lookingFor: ["Peers", "Dates"], intents: ["dating", "networking"], orientations: ["straight"] },

  { first: "Arjun", last: "Nair", gender: M, age: 29, occupation: "Backend Engineer at CRED", field: "software", education: "NIT Calicut", area: "Indiranagar", bio: "Distributed systems and distributed pizza. Football on weekends.", interests: ["Football", "Tech meetups", "Craft beer"], goals: ["Join a Sunday league"], lookingFor: ["Football team", "Friends"], intents: ["friendship", "networking"], orientations: ["straight"] },
  { first: "Rahul", last: "Menon", gender: M, age: 32, occupation: "Co-founder, Loop Mobility", field: "product", education: "IIT Madras", area: "HSR Layout", bio: "Building last-mile transit. Ask me about BMTC data, I dare you.", interests: ["Mobility", "Startups", "Cycling"], goals: ["Raise a seed round"], lookingFor: ["Investors", "Engineers"], intents: ["networking"], orientations: ["straight"] },
  { first: "Karthik", last: "Raghavan", gender: M, age: 27, occupation: "Violinist & sound engineer", field: "arts", education: "Bangalore University", area: "Malleshwaram", bio: "Carnatic violin, studio sessions, and a lot of filter coffee at Veena Stores.", interests: ["Carnatic music", "Audio", "Coffee"], goals: ["Tour Europe with my band"], lookingFor: ["Musicians"], intents: ["friendship"], orientations: ["straight"] },
  { first: "Vivek", last: "Shenoy", gender: M, age: 35, occupation: "Director of Engineering at Atlassian", field: "software", education: "Manipal Institute of Technology", area: "Whitefield", bio: "Hiring, mentoring, and trying to keep a sourdough starter alive.", interests: ["Leadership", "Baking", "Running"], goals: ["Mentor first-time managers"], lookingFor: ["Mentees", "Peers"], intents: ["networking", "just_here"], orientations: ["straight"] },
  { first: "Siddharth", last: "Rao", gender: M, age: 24, occupation: "Growth Marketer at Cult.fit", field: "marketing", education: "Christ University", area: "Koramangala", bio: "Gym at 6, growth experiments by 10, stand-up shows by 9 PM.", interests: ["Fitness", "Comedy", "Growth"], goals: ["Try an open mic"], lookingFor: ["Friends", "Dates"], intents: ["dating", "friendship"], orientations: ["straight"] },
  { first: "Mohammed", last: "Irfan", gender: M, age: 30, occupation: "Chef-owner, Bun Maska Café", field: "hospitality", education: "Christ University (Hotel Management)", area: "Frazer Town", bio: "Irani chai, bun maska and very late-night biryani runs.", interests: ["Food", "Cafés", "Football"], goals: ["Open a second outlet"], lookingFor: ["Food people", "Suppliers"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Aditya", last: "Deshpande", gender: M, age: 26, occupation: "Data Scientist at Walmart Labs", field: "data_ai", education: "IIIT Bangalore", area: "Electronic City", bio: "Forecasting demand, losing at Catan. Rematch?", interests: ["Board games", "AI", "Quizzing"], goals: ["Win a pub quiz"], lookingFor: ["Quiz team", "Friends"], intents: ["friendship", "dating"], orientations: ["straight"] },
  { first: "Rohit", last: "Kumar", gender: M, age: 31, occupation: "Cycling coach & bike fitter", field: "other", education: "Jain University", area: "Hebbal", bio: "I lead the Sunday Nandi rides. Lights on, helmets on, no one gets dropped.", interests: ["Cycling", "Fitness", "Travel"], goals: ["Grow the ride group"], lookingFor: ["Riders"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Nikhil", last: "Jain", gender: M, age: 28, occupation: "Chartered Accountant at Deloitte", field: "finance", education: "ICAI", area: "Jayanagar", bio: "Numbers all week, techno all weekend.", interests: ["Techno", "Travel", "Finance"], goals: ["Learn to DJ"], lookingFor: ["Friends", "Dates"], intents: ["dating", "friendship"], orientations: ["straight"] },
  { first: "Varun", last: "Gowda", gender: M, age: 33, occupation: "Architect, Studio Kaaru", field: "design", education: "BMS College of Architecture", area: "Basavanagudi", bio: "Building with mud and lime. I will show you my brick collection.", interests: ["Architecture", "Design festivals", "Heritage"], goals: ["Exhibit at the design festival"], lookingFor: ["Collaborators"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Abhishek", last: "Srinivasan", gender: M, age: 22, occupation: "Computer Science student at RVCE", field: "student", education: "RV College of Engineering", area: "Kengeri", bio: "Hackathons, competitive programming, and a lot of Maggi.", interests: ["Hackathons", "Coding", "Gaming"], goals: ["Win a hackathon"], lookingFor: ["Teammates", "Mentors"], intents: ["networking", "friendship"], orientations: ["straight"] },
  { first: "Faizan", last: "Ahmed", gender: M, age: 29, occupation: "Photographer (events & editorial)", field: "media", education: "Light & Life Academy", area: "Shivajinagar", bio: "I'm usually the one with the camera at the back. Say hi anyway.", interests: ["Photography", "Live music", "Film"], goals: ["Shoot a festival"], lookingFor: ["Creatives", "Friends"], intents: ["friendship", "networking"], orientations: ["straight"] },
  { first: "Pranav", last: "Hegde", gender: M, age: 27, occupation: "Mobile Engineer at Zepto", field: "software", education: "PES University", area: "Bellandur", bio: "React Native, road trips to Gokarna and the occasional pottery class.", interests: ["Mobile dev", "Travel", "Pottery"], goals: ["Ship an indie app"], lookingFor: ["Friends", "Dates"], intents: ["dating", "networking"], orientations: ["straight"] },
  { first: "Ravi", last: "Chandran", gender: M, age: 42, occupation: "Professor of Economics, Azim Premji University", field: "education", education: "JNU Delhi", area: "Sarjapur Road", bio: "Teaching development economics and collecting old Kannada film posters.", interests: ["Books", "Film", "Economics"], goals: ["Write a book on Bengaluru's economy"], lookingFor: ["Readers", "Friends"], intents: ["just_here", "friendship"], orientations: ["straight"] },
  { first: "Kunal", last: "Mehta", gender: M, age: 30, occupation: "Product Lead at Groww", field: "product", education: "IIM Ahmedabad", area: "Koramangala", bio: "Investing products for first-time investors. Weekend wine snob.", interests: ["Wine", "Product", "Tennis"], goals: ["Learn to cook properly"], lookingFor: ["Dates", "Friends"], intents: ["dating", "networking"], orientations: ["straight"] },
  { first: "Sameer", last: "Qureshi", gender: M, age: 25, occupation: "Stand-up comedian & copywriter", field: "media", education: "Bangalore University", area: "Indiranagar", bio: "Tuesday nights at BFlat. If you laughed, tell your friends. If you didn't, tell mine.", interests: ["Comedy", "Writing", "Football"], goals: ["Do a one-hour special"], lookingFor: ["Friends", "Collaborators"], intents: ["friendship", "dating"], orientations: ["straight"] },
  { first: "Harsha", last: "Vardhan", gender: M, age: 34, occupation: "Site Reliability Engineer at Google", field: "software", education: "IIT Bombay", area: "Hebbal", bio: "Keeping things up. Sunrise runs at Cubbon and very serious about idli.", interests: ["Running", "Infrastructure", "Food"], goals: ["Run the TCS 10K"], lookingFor: ["Running buddies"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Dev", last: "Malhotra", gender: M, age: 28, occupation: "Sales Lead at Freshworks", field: "sales", education: "Symbiosis Pune", area: "Domlur", bio: "Quota, cricket screenings, repeat. Arsenal fan, sorry.", interests: ["Football", "Cricket", "Craft beer"], goals: ["Find people to watch matches with"], lookingFor: ["Match buddies", "Dates"], intents: ["friendship", "dating"], orientations: ["straight"] },
  { first: "Manoj", last: "Shetty", gender: M, age: 37, occupation: "Operations Manager at Taj West End", field: "hospitality", education: "Welcomgroup Graduate School, Manipal", area: "Race Course Road", bio: "Hospitality lifer. I judge every brunch I attend. Kindly.", interests: ["Brunch", "Wine", "Jazz"], goals: ["Open a restaurant"], lookingFor: ["Food people"], intents: ["networking", "just_here"], orientations: ["straight"] },
  { first: "Tejas", last: "Kulkarni", gender: M, age: 23, occupation: "Junior Designer at Ather Energy", field: "design", education: "Srishti Institute", area: "Yelahanka", bio: "Industrial design, scooters and synthesizers.", interests: ["Industrial design", "Synths", "Electronic music"], goals: ["Build a synth"], lookingFor: ["Makers", "Friends"], intents: ["friendship", "networking"], orientations: ["gay"] },
  { first: "Naveen", last: "Prakash", gender: M, age: 31, occupation: "Civil Engineer at L&T Metro", field: "engineering", education: "UVCE Bengaluru", area: "Rajajinagar", bio: "I'm building the metro line you complain about. You're welcome, eventually.", interests: ["Infrastructure", "Cities", "Trekking"], goals: ["Trek Kumara Parvatha"], lookingFor: ["Trekking group", "Friends"], intents: ["friendship", "just_here"], orientations: ["straight"] },
  { first: "Yusuf", last: "Ali", gender: M, age: 26, occupation: "Barista & coffee roaster at Third Wave", field: "hospitality", education: "Bangalore University", area: "Koramangala", bio: "Latte art champion (district level, but still).", interests: ["Coffee", "Cycling", "Music"], goals: ["Compete at nationals"], lookingFor: ["Coffee people", "Dates"], intents: ["dating", "friendship"], orientations: ["straight"] },
  { first: "Gaurav", last: "Bose", gender: M, age: 39, occupation: "Partner at Khaitan & Co", field: "law_policy", education: "NLSIU Bengaluru", area: "Lavelle Road", bio: "Tech law, long lunches and a stubborn belief in the Oxford comma.", interests: ["Books", "Wine", "Tennis"], goals: ["Start a book club"], lookingFor: ["Readers", "Peers"], intents: ["networking", "just_here"], orientations: ["straight"] },
  { first: "Akash", last: "Verma", gender: M, age: 27, occupation: "Game Developer at Nazara", field: "software", education: "Manipal Institute of Technology", area: "HSR Layout", bio: "I make mobile games and play too many board games.", interests: ["Board games", "Games", "Anime"], goals: ["Design a board game"], lookingFor: ["Playtesters", "Friends"], intents: ["friendship", "dating"], orientations: ["bisexual"] },
]

const photoUrl = (id: string, size = 800) => `https://images.unsplash.com/${id}?w=${size}&h=${size}&fit=crop&crop=faces&q=80&fm=jpg`
const blurUrl = (id: string) => `https://images.unsplash.com/${id}?w=400&h=400&fit=crop&crop=faces&q=60&fm=jpg&blur=120`

const slugOf = (p: Person) => `${p.first}.${p.last}`.toLowerCase().replace(/[^a-z.]/g, "")
export const crowdEmail = (p: Person) => `${slugOf(p)}@${CROWD_DOMAIN}`

/** The same person on every run: date of birth follows age, pinned to a fixed day. */
function dobFor(p: Person, i: number): Date {
  const year = new Date().getUTCFullYear() - p.age - 1
  return new Date(Date.UTC(year, (i * 5) % 12, 1 + ((i * 7) % 27)))
}

/**
 * Create or refresh every crowd account and profile. Returns their ids in a
 * stable order, women and men interleaved so any slice is mixed.
 */
/**
 * Second photos, only where the extra is **the same person** as the main
 * portrait (same shoot or series). A second photo of somebody else would be a
 * profile that changes face when you swipe.
 */
const SAME_PERSON_EXTRA: Record<"women" | "men", Record<number, number>> = {
  women: { 13: 0, 19: 1, 8: 2 },
  men: { 3: 0, 17: 1 },
}

type Portrait = { id: string; alt: string }
const apparentAge = (p: Portrait) => Number(/~(\d+)/.exec(p.alt)?.[1] ?? 28)

/**
 * Create or refresh every crowd account and profile. Returns their ids in a
 * stable order, women and men interleaved so any slice is mixed.
 */
export async function ensureCrowd(db: PrismaClient): Promise<string[]> {
  const portraits = PORTRAITS as unknown as Record<"women" | "men" | "extra_women" | "extra_men", Portrait[]>
  const leafCats = await db.categories.findMany({ where: { parent_id: { not: null } }, orderBy: { slug: "asc" }, select: { id: true } })

  const women = PEOPLE.filter((p) => p.gender === "woman")
  const men = PEOPLE.filter((p) => p.gender === "man")
  const ordered = women.flatMap((w, i) => [w, men[i]]).filter(Boolean)

  // Youngest person gets the youngest-looking portrait, and so on up.
  const photoOf = new Map<Person, { main: string; extra: string | null }>()
  for (const [group, people] of [["women", women], ["men", men]] as const) {
    const pool = portraits[group].map((p, i) => ({ ...p, i })).sort((a, b) => apparentAge(a) - apparentAge(b))
    const byAge = [...people].sort((a, b) => a.age - b.age)
    const extras = portraits[group === "women" ? "extra_women" : "extra_men"]
    byAge.forEach((person, rank) => {
      const portrait = pool[rank % pool.length]
      const extraIdx = SAME_PERSON_EXTRA[group][portrait.i]
      photoOf.set(person, { main: portrait.id, extra: extraIdx !== undefined ? (extras[extraIdx]?.id ?? null) : null })
    })
  }

  const ids: string[] = []
  for (const [i, p] of ordered.entries()) {
    const { main, extra } = photoOf.get(p)!
    const photos = [photoUrl(main), ...(extra ? [photoUrl(extra)] : [])]
    const name = `${p.first} ${p.last}`
    const joined = new Date(Date.now() - (30 + i * 3) * 24 * 3_600_000)

    const user = await db.user.upsert({
      where: { email: crowdEmail(p) },
      update: { name, image: photos[0], role: "attendee", deletedAt: null, suspended_at: null },
      create: { email: crowdEmail(p), name, image: photos[0], role: "attendee", emailVerified: joined, password: null, createdAt: joined },
    })

    const expertise = expertiseFor(p.field).slice(i % 2, (i % 2) + 2).map((e) => e.slug)
    const profile = {
      name,
      phone: null,
      age: p.age,
      date_of_birth: dobFor(p, i),
      location: `${p.area}, Bengaluru`,
      bio: p.bio,
      occupation: p.occupation,
      work_field: p.field,
      expertise,
      education: p.education,
      interests: p.interests,
      photos,
      blur_photo: blurUrl(main),
      goals: p.goals,
      looking_for: p.lookingFor,
      onboarded: true,
      intent_default: p.intents,
      reveal_by_default: i % 3 !== 0,
      gender: p.gender,
      interested_in: deriveInterestedIn(p.gender as Gender, p.orientations) ?? [],
      orientations: p.orientations,
      show_orientation: i % 4 === 0,
      push_enabled: true,
      show_online: i % 5 !== 0,
      read_receipts: i % 6 !== 0,
      share_location: true,
      updated_at: new Date(),
    }
    await db.profiles.upsert({
      where: { id: user.id },
      update: profile,
      create: { id: user.id, ...profile, created_at: joined },
    })

    // The interest graph matching ranks on — three leaves, overlapping with neighbours.
    if (leafCats.length >= 3) {
      await db.user_interests.deleteMany({ where: { user_id: user.id } })
      await db.user_interests.createMany({
        data: [0, 7, 19].map((k) => ({ user_id: user.id, category_id: leafCats[(i * 3 + k) % leafCats.length].id })),
        skipDuplicates: true,
      })
    }
    ids.push(user.id)
  }
  return ids
}

export const CROWD_SIZE = PEOPLE.length

/** Short, believable reviews, used round-robin with the star rating beside them. */
export const CROWD_REVIEWS: [number, string][] = [
  [5, "Exactly what I hoped for. Met three people I'm already planning the next one with."],
  [4, "Great evening. Would have loved a bit more seating."],
  [5, "Well organised, friendly crowd, and the room chat made it easy to say hi."],
  [3, "Good event, but the entry queue took a while."],
  [5, "Loved it. The host made everyone feel welcome."],
  [4, "Fun night — the sound was a little loud near the front."],
  [5, "Came alone, left with a WhatsApp group. 10/10."],
  [4, "Really good. Parking was a pain, take a cab."],
  [2, "Too crowded for me, couldn't really talk to anyone."],
  [5, "Easily the best thing I've done in Bengaluru this month."],
  [4, "Solid. Would come again."],
  [5, "The people made it. Great mix of folks."],
]

/** Room chatter for busy rooms, spoken by the crowd. */
export const CROWD_CHAT = [
  "just got here, where's everyone sitting?",
  "the queue at the entrance is moving fast now",
  "anyone want to share a table?",
  "this is my first blendn event, hi all 👋",
  "whoever is in the green jacket — you dropped your card",
  "the second half is way better than the first",
  "found a spot near the back, plenty of room",
  "is there a vegetarian option at the counter?",
]
