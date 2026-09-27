// Everything about the creator that rarely changes lives here: name, bio,
// social profiles, form wording, and the starter links. Edit this file (or ask
// your coding agent to) and publish again to update the page.
//
// Links and featured products are different: the owner edits those from the
// owner view at /admin/links, and they are stored in the `links` collection.
// `starterLinks` below is only used when the owner clicks "Add starter links".

export const profile = {
  brand: "Kiln & Crumb",
  person: "Wren Okoro",
  role: "Potter, baker, pie-dish evangelist",
  bio: "I throw speckled pie dishes, fat-handled mugs and serving bowls in a tiny garage studio, then bake things to put in them. New pieces drop about once a month and go fast.",
  // Shown in the browser tab and in link previews on social apps.
  pageTitle: "Kiln & Crumb | Pie dishes, mugs, and the pie to go in them",
  pageDescription: "Handmade pie dishes and mugs by Wren Okoro. Shop the latest kiln drop, book a workshop, and get first dibs on new pieces."
};

// Social profiles shown as round buttons under the bio. `icon` must be one of
// the names in SOCIAL_ICONS in views.js.
export const socials = [
  { label: "Instagram", icon: "instagram", url: "https://example.com/kilnandcrumb/instagram" },
  { label: "TikTok", icon: "tiktok", url: "https://example.com/kilnandcrumb/tiktok" },
  { label: "YouTube", icon: "youtube", url: "https://example.com/kilnandcrumb/youtube" },
  { label: "Pinterest", icon: "pinterest", url: "https://example.com/kilnandcrumb/pinterest" }
];

export const emailList = {
  heading: "Get first dibs on kiln drops",
  body: "One email a month, the day before a drop opens. Plus the occasional pie.",
  button: "Count me in",
  thanks: "You're on the list. Watch your inbox the day before the next drop."
};

export const contact = {
  heading: "Wholesale, collabs, or a pie question?",
  body: "Send me a note. I read everything and usually reply within two days.",
  button: "Send a note",
  // Topics shown in the contact form. Keep them short.
  topics: ["Order question", "Wholesale", "Workshop", "Collab", "Something else"],
  thanks: "Thanks for the note! I'll write back within two days."
};

// Pictures the owner can choose for a link. Each name matches a file in
// public/img/<name>.svg. Add a file and a name here to offer a new picture.
export const pictures = [
  { value: "pie-dish", label: "Pie dish" },
  { value: "mug", label: "Mug" },
  { value: "zine", label: "Zine" },
  { value: "bowl", label: "Bowl" },
  { value: "slice", label: "Pie slice" },
  { value: "wheel", label: "Pottery wheel" },
  { value: "video", label: "Video" },
  { value: "plate", label: "Plate" }
];

// Starter links. `featured: true` items show as product cards with a price;
// the rest show as the list of links.
export const starterLinks = [
  {
    title: "Speckled Pie Dish",
    note: "9 inches, oven to table. Oatmeal glaze, cobalt rim.",
    price: "$48",
    picture: "pie-dish",
    url: "https://shop.example.com/speckled-pie-dish",
    featured: true
  },
  {
    title: "Morning Mugs, set of two",
    note: "Fat handles, 12 oz, dishwasher safe.",
    price: "$64",
    picture: "mug",
    url: "https://shop.example.com/morning-mugs",
    featured: true
  },
  {
    title: "The Crumb Zine: 12 Pies",
    note: "Recipes, crust tips, and which dish to bake them in.",
    price: "$18",
    picture: "zine",
    url: "https://shop.example.com/crumb-zine",
    featured: true
  },
  {
    title: "Shop the October kiln drop",
    note: "18 pieces. Opens Friday at 10am.",
    picture: "bowl",
    url: "https://shop.example.com/october-drop"
  },
  {
    title: "Watch me throw a pie dish in 90 seconds",
    note: "New video every Tuesday",
    picture: "video",
    url: "https://video.example.com/pie-dish-90-seconds"
  },
  {
    title: "Wheel & Pie workshops",
    note: "Saturdays, six seats. Throw a dish, eat a pie.",
    picture: "wheel",
    url: "https://tickets.example.com/wheel-and-pie"
  },
  {
    title: "Brown-butter apple pie recipe",
    note: "The one everyone asks for",
    picture: "slice",
    url: "https://example.com/recipes/brown-butter-apple-pie"
  },
  {
    title: "Wholesale and cafe orders",
    note: "Custom mugs for your counter",
    picture: "plate",
    url: "https://example.com/wholesale"
  }
];
