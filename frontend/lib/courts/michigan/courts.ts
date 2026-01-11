export const MICHIGAN_COURTS = {
  appellate: ["mich", "michctapp"],
  federal: ["mied", "miwd", "ca6"],
  circuit: {
    wayne: {
      name: "Wayne County Circuit Court",
      type: "odyssey",
      publicSearch: "https://www.3rdcc.org/odyssey/case-search",
    },
    oakland: {
      name: "Oakland County Circuit Court",
      type: "custom",
      publicSearch: "https://www.oakgov.com/courts/circuit/Pages/case-search.aspx",
    },
  },
};
