// Has to be in the head tag, otherwise a flicker effect will occur.

let toggleTheme = (theme) => {
  const next = (theme == "dark") ? "light" : "dark";
  // Remember the visitor's own choice: it wins over any page default, on every page.
  localStorage.setItem("theme-chosen", next);
  setTheme(next);
}


let setTheme = (theme) =>  {
  transTheme();
  setHighlight(theme);
  setGiscusTheme(theme);

  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);

    // Add class to tables.
    let tables = document.getElementsByTagName('table');
    for(let i = 0; i < tables.length; i++) {
      if (theme == "dark") {
        tables[i].classList.add('table-dark');
      } else {
        tables[i].classList.remove('table-dark');
      }
    }
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  localStorage.setItem("theme", theme);

  // Updates the background of medium-zoom overlay.
  if (typeof medium_zoom !== 'undefined') {
    medium_zoom.update({
      background: getComputedStyle(document.documentElement)
          .getPropertyValue('--global-bg-color') + 'ee',  // + 'ee' for trasparency.
    })
  }
};


let setHighlight = (theme) => {
  if (theme == "dark") {
    document.getElementById("highlight_theme_light").media = "none";
    document.getElementById("highlight_theme_dark").media = "";
  } else {
    document.getElementById("highlight_theme_dark").media = "none";
    document.getElementById("highlight_theme_light").media = "";
  }
}


let setGiscusTheme = (theme) => {

  function sendMessage(message) {
    const iframe = document.querySelector('iframe.giscus-frame');
    if (!iframe) return;
    iframe.contentWindow.postMessage({ giscus: message }, 'https://giscus.app');
  }

  sendMessage({
    setConfig: {
      theme: theme
    }
  });

}


let transTheme = () => {
  document.documentElement.classList.add("transition");
  window.setTimeout(() => {
    document.documentElement.classList.remove("transition");
  }, 500)
}


// Which theme a page opens in:
//   1. the visitor's own choice, if they have used the toggle;
//   2. else the page's default (front matter `default_theme: dark`, see head.html);
//   3. else the system preference.
let initTheme = () => {
  let theme = localStorage.getItem("theme-chosen");
  if (theme != "dark" && theme != "light") {
    theme = window.PAGE_DEFAULT_THEME || null;
    if (theme != "dark" && theme != "light") {
      const userPref = window.matchMedia;
      theme = (userPref && userPref('(prefers-color-scheme: dark)').matches) ? 'dark' : null;
    }
  }

  setTheme(theme);
}


initTheme();
